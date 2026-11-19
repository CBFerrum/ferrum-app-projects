//! Importing a task tree from a file (PRJ-15). A `TaskImport` names a project, a mapping and a CSV file attached to
//! it. What another product calls its columns, how it writes a day and what its statuses mean are the mapping's
//! (`TaskImportMapping`, records a workspace edits); the code reads "a CSV file through a mapping". **Check** reads
//! the file and writes what it found onto the import, making no task.

use crate::logic::CLOSED_PROJECT;
use crate::project::{label, try_get};
use crate::status::statuses_for;
use async_trait::async_trait;
use chrono::{NaiveDate, NaiveDateTime};
use ferrum_domain::util::{elevated, id, rows, s, sys};
use ferrum_kernel::{Doc, DocHook, Error, HookCtx, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;

/// The largest file read, in bytes.
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// The most rows under the heading row.
const MAX_ROWS: usize = 500;
/// The most problems written onto the import.
const MAX_PROBLEMS: usize = 200;
const MAX_SUBJECT: usize = 300;
const MAX_DESCRIPTION: usize = 20_000;

/// A file's headings and rows, cells trimmed, empty rows dropped.
#[derive(Debug)]
pub(crate) struct Sheet {
    pub headings: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// One thing that would refuse the import: the file's row (the heading row is 1; 0 is the file or the mapping),
/// the column's heading, what is wrong.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Problem {
    pub row: usize,
    pub column: String,
    pub what: String,
}

impl Problem {
    fn new(row: usize, column: &str, what: impl Into<String>) -> Self {
        Problem { row, column: column.to_string(), what: what.into() }
    }
}

/// A row as it would become a task. `parent` and `deps` are indexes into the planned list.
#[derive(Debug, Clone, Default)]
pub(crate) struct Planned {
    pub row: usize,
    pub key: String,
    pub subject: String,
    pub parent: Option<usize>,
    pub deps: Vec<usize>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub people: Vec<String>,
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
    pub hours: Option<Decimal>,
    pub points: Option<Decimal>,
    pub milestone: bool,
    pub description: Option<String>,
}

/// What the code reads of a mapping.
#[derive(Debug, Clone, Default)]
pub(crate) struct Mapping {
    /// target → the heading in the file.
    pub columns: Vec<(String, String)>,
    /// (field, value in the file, what it becomes).
    pub values: Vec<(String, String, String)>,
    pub date_format: String,
    pub list_separator: String,
    pub hours_unit: String,
    pub leave_out_people: bool,
    pub leave_out_links: bool,
}

impl Mapping {
    pub(crate) fn of(doc: &Doc) -> Mapping {
        Mapping {
            columns: rows(doc, "columns").iter().filter_map(|r| Some((s(r, "target")?.to_string(), s(r, "source")?.to_string()))).collect(),
            values: rows(doc, "values")
                .iter()
                .filter_map(|r| Some((s(r, "field")?.to_string(), s(r, "source")?.to_string(), s(r, "becomes")?.to_string())))
                .collect(),
            date_format: s(doc, "date_format").unwrap_or("%Y-%m-%d").to_string(),
            list_separator: s(doc, "list_separator").filter(|v| !v.is_empty()).unwrap_or(",").to_string(),
            hours_unit: s(doc, "hours_unit").unwrap_or("Hours").to_string(),
            leave_out_people: s(doc, "unknown_people") == Some("Leave Out"),
            leave_out_links: s(doc, "unknown_links") == Some("Leave Out"),
        }
    }

    /// What a value in the file becomes for `field` (Status or Priority), when the mapping says.
    fn value(&self, field: &str, v: &str) -> Option<&str> {
        self.values.iter().find(|(f, src, _)| f == field && src.trim().eq_ignore_ascii_case(v.trim())).map(|(_, _, to)| to.as_str())
    }
}

/// Whichever of comma, semicolon and tab is most frequent in the first line, outside quotes (comma when none).
pub(crate) fn separator(text: &str) -> u8 {
    let first = text.lines().next().unwrap_or_default();
    let (mut quoted, mut counts) = (false, [0usize; 3]);
    for c in first.chars() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => counts[0] += 1,
            ';' if !quoted => counts[1] += 1,
            '\t' if !quoted => counts[2] += 1,
            _ => {}
        }
    }
    let best = (0..3).max_by_key(|i| (counts[*i], std::cmp::Reverse(*i))).unwrap_or(0);
    if counts[best] == 0 { b',' } else { [b',', b';', b'\t'][best] }
}

/// The file as headings and rows: UTF-8 (a byte-order mark dropped), its separator guessed, quoted cells read as
/// CSV does (doubled quotes, line breaks inside quotes), cells trimmed, empty rows dropped.
pub(crate) fn read_csv(bytes: &[u8]) -> std::result::Result<Sheet, Problem> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| Problem::new(0, "file", "save the file as UTF-8"))?;
    let mut reader = csv::ReaderBuilder::new().delimiter(separator(text)).flexible(true).has_headers(false).from_reader(text.as_bytes());
    let mut all = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| Problem::new(0, "file", format!("cannot be read as CSV: {e}")))?;
        let cells: Vec<String> = record.iter().map(|c| c.trim().to_string()).collect();
        if cells.iter().any(|c| !c.is_empty()) {
            all.push(cells);
        }
    }
    let mut all = all.into_iter();
    let headings = all.next().ok_or_else(|| Problem::new(0, "file", "has no heading row"))?;
    let rows: Vec<Vec<String>> = all.collect();
    if rows.is_empty() {
        return Err(Problem::new(0, "file", "has no row under its headings"));
    }
    if rows.len() > MAX_ROWS {
        return Err(Problem::new(0, "file", format!("has more than {MAX_ROWS} rows; split it into several imports")));
    }
    Ok(Sheet { headings, rows })
}

/// A day as the mapping's pattern writes it; a pattern with a time of day keeps the day.
fn day(v: &str, pattern: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(v, pattern).ok().or_else(|| NaiveDateTime::parse_from_str(v, pattern).ok().map(|t| t.date()))
}

fn number(v: &str) -> Option<Decimal> {
    Decimal::from_str(v.trim()).ok().filter(|d| !d.is_sign_negative())
}

const PRIORITIES: [&str; 4] = ["Low", "Medium", "High", "Urgent"];

/// The rows as tasks through the mapping, and every problem found: pure, so it is tested without a database.
/// Statuses stay as written (`status`); people are tokens (`people`); both are resolved by [`resolve`].
pub(crate) fn plan(sheet: &Sheet, m: &Mapping) -> (Vec<Planned>, Vec<Problem>) {
    let mut problems = Vec::new();
    let mut col: HashMap<&str, (usize, &str)> = HashMap::new();
    let mut seen = HashSet::new();
    for (target, source) in &m.columns {
        if !seen.insert(target.as_str()) {
            problems.push(Problem::new(0, source, format!("the mapping names {target} twice")));
            continue;
        }
        match sheet.headings.iter().position(|h| h.trim().eq_ignore_ascii_case(source.trim())) {
            Some(i) => {
                col.insert(target.as_str(), (i, source.as_str()));
            }
            None if target == "Subject" => problems.push(Problem::new(0, source, "is not a heading of the file")),
            None => {}
        }
    }
    let Some(&(subject_at, subject_head)) = col.get("Subject") else {
        if !m.columns.iter().any(|(t, _)| t == "Subject") {
            problems.push(Problem::new(0, "Subject", "the mapping names no column for the task's title"));
        }
        return (vec![], problems);
    };
    let cell = |r: &[String], target: &str| -> Option<(String, &str)> {
        col.get(target).and_then(|(i, head)| r.get(*i).filter(|v| !v.is_empty()).map(|v| (v.clone(), *head)))
    };
    let mut out: Vec<Planned> = Vec::with_capacity(sheet.rows.len());
    let mut keys: HashMap<String, usize> = HashMap::new();
    for (i, r) in sheet.rows.iter().enumerate() {
        let row = i + 2;
        let mut p = Planned { row, ..Default::default() };
        p.subject = r.get(subject_at).cloned().unwrap_or_default();
        if p.subject.is_empty() {
            problems.push(Problem::new(row, subject_head, "is empty"));
        } else if p.subject.chars().count() > MAX_SUBJECT {
            problems.push(Problem::new(row, subject_head, format!("is longer than {MAX_SUBJECT} characters")));
        }
        p.key = cell(r, "Key").map(|c| c.0).unwrap_or_else(|| row.to_string());
        if keys.insert(p.key.clone(), i).is_some() {
            let head = col.get("Key").map_or("Key", |c| c.1);
            problems.push(Problem::new(row, head, format!("{} is the key of an earlier row", p.key)));
        }
        out.push(p);
    }
    // A reference to another row: its key, else the one row with that subject.
    let find = |token: &str, out: &[Planned]| -> std::result::Result<usize, &'static str> {
        if let Some(&i) = keys.get(token) {
            return Ok(i);
        }
        let named: Vec<usize> = (0..out.len()).filter(|j| out[*j].subject.eq_ignore_ascii_case(token)).collect();
        match named.as_slice() {
            [one] => Ok(*one),
            [] => Err("is no row of the file"),
            _ => Err("names several rows of the file"),
        }
    };
    let snapshot = out.clone();
    for (i, r) in sheet.rows.iter().enumerate() {
        let row = i + 2;
        if let Some(&(at, head)) = col.get("Level") {
            match r.get(at).map(|v| v.trim()).filter(|v| !v.is_empty()).map(|v| v.parse::<u32>()) {
                Some(Ok(level)) if level >= 1 => {
                    let levels: Vec<Option<u32>> = sheet.rows[..i].iter().map(|r| r.get(at).and_then(|v| v.trim().parse::<u32>().ok())).collect();
                    out[i].parent = (0..i).rev().find(|j| levels[*j].is_some_and(|l| l < level));
                }
                None => {}
                Some(_) => problems.push(Problem::new(row, head, "is not a level of 1 or more")),
            }
        } else if let Some((v, head)) = cell(r, "Parent") {
            match find(&v, &snapshot) {
                Ok(j) => out[i].parent = Some(j),
                Err(what) => problems.push(Problem::new(row, head, what)),
            }
        }
        if let Some((v, head)) = cell(r, "Depends On") {
            for token in v.split(m.list_separator.as_str()).map(str::trim).filter(|t| !t.is_empty()) {
                match find(token, &snapshot) {
                    Ok(j) if j == i => problems.push(Problem::new(row, head, "a task cannot wait for itself")),
                    Ok(j) => {
                        if !out[i].deps.contains(&j) {
                            out[i].deps.push(j);
                        }
                    }
                    Err(_) if m.leave_out_links => {}
                    Err(what) => problems.push(Problem::new(row, head, format!("{token} {what}"))),
                }
            }
        }
        for (target, slot) in [("Start", 0), ("End", 1)] {
            if let Some((v, head)) = cell(r, target) {
                match day(&v, &m.date_format) {
                    Some(d) if slot == 0 => out[i].start = Some(d),
                    Some(d) => out[i].end = Some(d),
                    None => problems.push(Problem::new(row, head, format!("{v} is not a day as the mapping writes one ({})", m.date_format))),
                }
            }
        }
        if let (Some(a), Some(b)) = (out[i].start, out[i].end)
            && b < a
        {
            let head = col.get("End").map_or("End", |c| c.1);
            problems.push(Problem::new(row, head, "is before the start"));
        }
        if let Some((v, head)) = cell(r, "Hours") {
            let per = match m.hours_unit.as_str() {
                "Minutes" => Decimal::from(60),
                "Seconds" => Decimal::from(3600),
                _ => Decimal::ONE,
            };
            match number(&v) {
                Some(h) => out[i].hours = Some((h / per).round_dp(2)),
                None => problems.push(Problem::new(row, head, format!("{v} is not a number of 0 or more"))),
            }
        }
        if let Some((v, head)) = cell(r, "Points") {
            match number(&v) {
                Some(p) => out[i].points = Some(p),
                None => problems.push(Problem::new(row, head, format!("{v} is not a number of 0 or more"))),
            }
        }
        if let Some((v, head)) = cell(r, "Priority") {
            let to = m.value("Priority", &v).map(str::to_string).or_else(|| PRIORITIES.iter().find(|p| p.eq_ignore_ascii_case(&v)).map(|p| p.to_string()));
            match to.filter(|p| PRIORITIES.contains(&p.as_str())) {
                Some(p) => out[i].priority = Some(p),
                None => problems.push(Problem::new(row, head, format!("{v} is not a priority here"))),
            }
        }
        if let Some((v, head)) = cell(r, "Milestone") {
            match v.to_lowercase().as_str() {
                "yes" | "true" | "1" | "x" => out[i].milestone = true,
                "no" | "false" | "0" => {}
                _ => problems.push(Problem::new(row, head, format!("{v} is neither yes nor no"))),
            }
        }
        if let Some((v, head)) = cell(r, "Description") {
            if v.chars().count() > MAX_DESCRIPTION {
                problems.push(Problem::new(row, head, format!("is longer than {MAX_DESCRIPTION} characters")));
            } else {
                out[i].description = Some(v);
            }
        }
        out[i].status = cell(r, "Status").map(|c| c.0);
        if let Some((v, _)) = cell(r, "Assignees") {
            out[i].people = v.split(m.list_separator.as_str()).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect();
        }
    }
    // A row under itself (its parent chain comes back to it).
    for i in 0..out.len() {
        let mut at = out[i].parent;
        for _ in 0..50 {
            match at {
                Some(j) if j == i => {
                    let head = col.get("Parent").or(col.get("Level")).map_or("Parent", |c| c.1);
                    problems.push(Problem::new(out[i].row, head, "the task would be under itself"));
                    break;
                }
                Some(j) => at = out[j].parent,
                None => break,
            }
        }
    }
    problems.sort_by_key(|p| p.row);
    (out, problems)
}

pub struct ImportHook;

#[async_trait]
impl DocHook for ImportHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let project = id(doc, "project").ok_or_else(|| Error::field("project", "is required"))?;
        let p = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "Project", project).await?.ok_or_else(|| Error::field("project", "does not exist"))?;
        if p.get("proj_is_template").and_then(Value::as_bool) == Some(true) {
            return Err(Error::field("project", "is a template; import into a project"));
        }
        if let Some(st) = s(&p, "status").filter(|st| CLOSED_PROJECT.contains(st)) {
            return Err(Error::field("project", format!("project {} is {}; reopen it to import into it", label(&p), st.to_lowercase())));
        }
        if let Some(i) = id(doc, "id")
            && let Some(old) = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "TaskImport", i).await?
            && s(&old, "state") == Some("Imported")
            && !hc.ctx.is_system
        {
            return Err(Error::invalid("an import that was made is kept as it was"));
        }
        Ok(())
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, _params: &Value) -> Result<Option<Value>> {
        match name {
            "check" => check(hc, doc).await.map(Some),
            _ => Ok(None),
        }
    }
}

/// Reads the import's file through its mapping, finds people and statuses in the workspace and the project's
/// workflow, and gives the planned tasks with every problem (steps shared by Check and Import).
pub(crate) async fn resolve(hc: &mut HookCtx<'_>, import: &Doc) -> Result<(Vec<Planned>, Vec<Problem>)> {
    // An attach field holds the file's address, its last part the file's id.
    let file =
        s(import, "file").and_then(|u| u.rsplit('/').next()).and_then(|f| f.parse().ok()).ok_or_else(|| Error::field("file", "attach the file first"))?;
    let info = hc.kernel.file_info(hc.ctx, file).await?;
    if info.size as u64 > MAX_BYTES {
        return Err(Error::field("file", "is larger than 2 MB; split it into several imports"));
    }
    let (_, _, bytes) = hc.kernel.read_file(hc.ctx, file).await?;
    let sheet = read_csv(&bytes).map_err(|p| Error::field("file", p.what))?;
    let mapping_id = id(import, "mapping").ok_or_else(|| Error::field("mapping", "is required"))?;
    let mapping = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "TaskImportMapping", mapping_id).await?.ok_or_else(|| Error::field("mapping", "does not exist"))?;
    let m = Mapping::of(&mapping);
    let project = id(import, "project").ok_or_else(|| Error::field("project", "is required"))?;
    let project = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "Project", project).await?.ok_or_else(|| Error::field("project", "does not exist"))?;
    let (mut planned, mut problems) = plan(&sheet, &m);
    let head = |target: &str| m.columns.iter().find(|(t, _)| t == target).map_or(target.to_string(), |c| c.1.clone());

    // People: an address, or exactly one person's full name.
    let users: Vec<(String, Option<String>)> = sqlx::query_as("select lower(email::text), full_name from app_user where tenant_id = $1 and is_active")
        .bind(hc.ctx.tenant)
        .fetch_all(&mut **hc.tx)
        .await?;
    let person = |token: &str| -> Option<String> {
        let t = token.trim().to_lowercase();
        if users.iter().any(|(e, _)| *e == t) {
            return Some(t);
        }
        let named: Vec<&String> = users.iter().filter(|(_, n)| n.as_deref().is_some_and(|n| n.trim().to_lowercase() == t)).map(|(e, _)| e).collect();
        (named.len() == 1).then(|| named[0].clone())
    };
    for p in planned.iter_mut() {
        let mut found = Vec::new();
        for token in std::mem::take(&mut p.people) {
            match person(&token) {
                Some(e) if !found.contains(&e) => found.push(e),
                Some(_) => {}
                None if m.leave_out_people => {}
                None => problems.push(Problem::new(p.row, &head("Assignees"), "no user of this workspace")),
            }
        }
        p.people = found;
    }

    // Statuses through the project's workflow.
    let list = statuses_for(hc.ctx, hc.tx, &project).await?;
    for p in planned.iter_mut() {
        let Some(v) = p.status.take() else { continue };
        if list.is_empty() {
            p.status = Some(v);
            continue;
        }
        if let Some(category) = m.value("Status", &v) {
            match list.iter().find(|s| s.category == category) {
                Some(st) => p.status = Some(st.name.clone()),
                None => problems.push(Problem::new(p.row, &head("Status"), format!("{v} is {category}, which the project's workflow has no status for"))),
            }
        } else if let Some(st) = list.iter().find(|s| s.name.eq_ignore_ascii_case(&v)) {
            p.status = Some(st.name.clone());
        } else {
            problems.push(Problem::new(p.row, &head("Status"), format!("{v} is not a status of the project's workflow")));
        }
    }
    problems.sort_by_key(|p| p.row);
    Ok((planned, problems))
}

/// The problems as the import shows them: one line each, at most 200, then how many more.
fn problem_text(problems: &[Problem]) -> Option<String> {
    if problems.is_empty() {
        return None;
    }
    let mut lines: Vec<String> = problems.iter().take(MAX_PROBLEMS).map(|p| format!("row {}: {}: {}", p.row, p.column, p.what)).collect();
    if problems.len() > MAX_PROBLEMS {
        lines.push(format!("and {} more", problems.len() - MAX_PROBLEMS));
    }
    Some(lines.join("\n"))
}

/// `check`: what the file would make and what would refuse it, written onto the import; no task is made.
async fn check(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<Value> {
    let import = id(doc, "id").ok_or_else(|| Error::internal("an import without an id"))?;
    let (planned, problems) = resolve(hc, doc).await?;
    let state = if problems.is_empty() { "Checked" } else { "Draft" };
    let values = Doc::from_iter([
        ("rows_found".to_string(), json!(planned.len())),
        ("problems".to_string(), problem_text(&problems).map_or(Value::Null, Value::from)),
        ("state".to_string(), json!(state)),
    ]);
    hc.kernel.update_tx(&elevated(hc.ctx), hc.tx, "TaskImport", import, values, None).await?;
    Ok(json!({"state": state, "rows": planned.len(), "problems": problems.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(text: &str) -> Sheet {
        read_csv(text.as_bytes()).unwrap()
    }

    fn mapping(cols: &[(&str, &str)]) -> Mapping {
        Mapping {
            columns: cols.iter().map(|(t, s)| (t.to_string(), s.to_string())).collect(),
            date_format: "%Y-%m-%d".into(),
            list_separator: ",".into(),
            hours_unit: "Hours".into(),
            ..Default::default()
        }
    }

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn separator_is_guessed() {
        assert_eq!(separator("a,b,c"), b',');
        assert_eq!(separator("a;b;c"), b';');
        assert_eq!(separator("a\tb\tc"), b'\t');
        assert_eq!(separator("\"x, y\";b;c"), b';', "a comma inside quotes does not count");
        assert_eq!(separator("one"), b',');
    }

    #[test]
    fn a_tree_by_parent_key() {
        let s = sheet("Key,Task,Parent\nA,Design,\nB,Wireframes,A\nC,Build,\n");
        let (p, problems) = plan(&s, &mapping(&[("Key", "Key"), ("Subject", "Task"), ("Parent", "Parent")]));
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(p.iter().map(|x| x.parent).collect::<Vec<_>>(), [None, Some(0), None]);
    }

    #[test]
    fn a_tree_by_level() {
        let s = sheet("Name,Level\nA,1\nB,2\nC,2\nD,1\nE,2\n");
        let (p, problems) = plan(&s, &mapping(&[("Subject", "Name"), ("Level", "Level")]));
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(p.iter().map(|x| x.parent).collect::<Vec<_>>(), [None, Some(0), Some(0), None, Some(3)]);
    }

    #[test]
    fn a_parent_by_unique_subject() {
        let s = sheet("Task,Parent\nDesign,\nWireframes,design\n");
        let (p, problems) = plan(&s, &mapping(&[("Subject", "Task"), ("Parent", "Parent")]));
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(p[1].parent, Some(0));
    }

    #[test]
    fn two_rows_of_one_subject_cannot_be_a_parent() {
        let s = sheet("Task,Parent\nReview,\nReview,\nNotes,Review\n");
        let (_, problems) = plan(&s, &mapping(&[("Subject", "Task"), ("Parent", "Parent")]));
        assert_eq!(problems, [Problem::new(4, "Parent", "names several rows of the file")]);
    }

    #[test]
    fn a_row_under_itself_is_a_problem() {
        let s = sheet("Key,Task,Parent\nA,One,B\nB,Two,A\n");
        let (_, problems) = plan(&s, &mapping(&[("Key", "Key"), ("Subject", "Task"), ("Parent", "Parent")]));
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems.iter().all(|p| p.what.contains("under itself")));
    }

    #[test]
    fn dependencies_by_key_and_left_out_when_the_mapping_says() {
        let s = sheet("Key,Task,Depends On\nA,One,\nB,Two,\"A, Z\"\n");
        let mut m = mapping(&[("Key", "Key"), ("Subject", "Task"), ("Depends On", "Depends On")]);
        let (p, problems) = plan(&s, &m);
        assert_eq!(p[1].deps, [0]);
        assert_eq!(problems, [Problem::new(3, "Depends On", "Z is no row of the file")]);
        m.leave_out_links = true;
        assert!(plan(&s, &m).1.is_empty());
    }

    #[test]
    fn dates_in_the_mappings_pattern() {
        let mut m = mapping(&[("Subject", "Task"), ("Start", "Start"), ("End", "End")]);
        let (p, _) = plan(&sheet("Task,Start,End\nA,2026-11-02,2026-11-06\n"), &m);
        assert_eq!((p[0].start, p[0].end), (Some(d("2026-11-02")), Some(d("2026-11-06"))));
        m.date_format = "%d/%m/%Y".into();
        let (p, _) = plan(&sheet("Task,Start,End\nA,02/11/2026,06/11/2026\n"), &m);
        assert_eq!(p[0].end, Some(d("2026-11-06")));
        m.date_format = "%d/%b/%y %I:%M %p".into();
        let (p, problems) = plan(&sheet("Task,Start,End\nA,02/Nov/26 9:30 AM,06/Nov/26 5:00 PM\n"), &m);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(p[0].end, Some(d("2026-11-06")), "the time of day is dropped");
        let (_, problems) = plan(&sheet("Task,Start,End\nA,yesterday,\n"), &m);
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn end_before_start() {
        let (_, problems) = plan(&sheet("Task,Start,End\nA,2026-11-06,2026-11-02\n"), &mapping(&[("Subject", "Task"), ("Start", "Start"), ("End", "End")]));
        assert_eq!(problems, [Problem::new(2, "End", "is before the start")]);
    }

    #[test]
    fn hours_in_seconds() {
        let mut m = mapping(&[("Subject", "Task"), ("Hours", "Estimate")]);
        m.hours_unit = "Seconds".into();
        let (p, _) = plan(&sheet("Task,Estimate\nA,9000\n"), &m);
        assert_eq!(p[0].hours, Some(Decimal::from_str("2.5").unwrap()));
        let (_, problems) = plan(&sheet("Task,Estimate\nA,-1\n"), &m);
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn values_map_statuses_and_priorities() {
        let mut m = mapping(&[("Subject", "Task"), ("Priority", "Priority"), ("Status", "Status")]);
        m.values = vec![("Priority".into(), "Highest".into(), "Urgent".into())];
        let (p, problems) = plan(&sheet("Task,Priority,Status\nA,Highest,Doing\nB,low,\nC,Whenever,\n"), &m);
        assert_eq!((p[0].priority.as_deref(), p[1].priority.as_deref()), (Some("Urgent"), Some("Low")));
        assert_eq!(p[0].status.as_deref(), Some("Doing"), "statuses are resolved against the project's workflow");
        assert_eq!(problems, [Problem::new(4, "Priority", "Whenever is not a priority here")]);
    }

    #[test]
    fn a_duplicate_key() {
        let (_, problems) = plan(&sheet("Key,Task\nA,One\nA,Two\n"), &mapping(&[("Key", "Key"), ("Subject", "Task")]));
        assert_eq!(problems, [Problem::new(3, "Key", "A is the key of an earlier row")]);
    }

    #[test]
    fn a_missing_subject() {
        let (_, problems) = plan(&sheet("Task,Notes\n,something\n"), &mapping(&[("Subject", "Task")]));
        assert_eq!(problems, [Problem::new(2, "Task", "is empty")]);
        let (_, problems) = plan(&sheet("Name\nA\n"), &mapping(&[("Subject", "Task")]));
        assert_eq!(problems, [Problem::new(0, "Task", "is not a heading of the file")]);
        let (_, problems) = plan(&sheet("Name\nA\n"), &mapping(&[("Key", "Name")]));
        assert_eq!(problems.len(), 1, "a mapping without a title column");
    }

    #[test]
    fn quoted_cells_with_line_breaks_and_a_byte_order_mark() {
        let s = read_csv("\u{feff}Task;Description\n\"Say \"\"hi\"\"\";\"two\nlines\"\n\n".as_bytes()).unwrap();
        assert_eq!(s.headings, ["Task", "Description"]);
        assert_eq!(s.rows, [vec!["Say \"hi\"".to_string(), "two\nlines".to_string()]]);
    }

    #[test]
    fn not_utf8() {
        assert_eq!(read_csv(&[b'T', 0xff, b'\n', b'a']).unwrap_err().what, "save the file as UTF-8");
    }

    #[test]
    fn more_than_500_rows() {
        let text = format!("Task\n{}", "a\n".repeat(501));
        assert!(read_csv(text.as_bytes()).unwrap_err().what.contains("more than 500 rows"));
        assert!(read_csv(format!("Task\n{}", "a\n".repeat(500)).as_bytes()).is_ok());
    }
}
