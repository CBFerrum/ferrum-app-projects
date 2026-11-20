//! Pure project maths: time spans, overlaps, dependency cycles, progress, billing status and the
//! grouping of time logs into invoice lines. No I/O, so every rule here is unit-tested.

use chrono::{DateTime, NaiveDate, TimeDelta, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};
use uuid::Uuid;

/// Status categories (a task status record's `category`): what the app reads of a status, never its name.
pub const TO_DO: &str = "To Do";
pub const IN_PROGRESS: &str = "In Progress";
pub const DONE: &str = "Done";
pub const CANCELLED: &str = "Cancelled";
/// Categories that mean work has started (blocked while a dependency is not done).
pub const STARTED: &[&str] = &[IN_PROGRESS, DONE];
/// Categories that close a task.
pub const CLOSED: &[&str] = &[DONE, CANCELLED];
/// Project statuses that freeze its tasks and refuse new time.
pub const CLOSED_PROJECT: &[&str] = &["Completed", "Cancelled"];

pub type Span = (DateTime<Utc>, DateTime<Utc>);

/// Hours between two instants, at the 9 decimals quantities are stored with.
pub fn hours_between(from: DateTime<Utc>, to: DateTime<Utc>) -> Decimal {
    (Decimal::from((to - from).num_milliseconds()) / Decimal::from(3_600_000)).round_dp(9)
}

/// End of a span starting at `from` that lasts `hours` (to the millisecond); `None` if out of range.
pub fn add_hours(from: DateTime<Utc>, hours: Decimal) -> Option<DateTime<Utc>> {
    let ms = (hours * Decimal::from(3_600_000)).round().to_i64()?;
    from.checked_add_signed(TimeDelta::try_milliseconds(ms)?)
}

/// Half-open spans overlap when each starts before the other ends (back-to-back is fine).
pub fn overlaps(a: Span, b: Span) -> bool {
    a.0 < b.1 && b.0 < a.1
}

/// The first pair of overlapping spans (indexes, lower first), in one sweep over the spans sorted
/// by start: a span overlaps an earlier one exactly when it starts before the latest end so far.
pub fn first_overlap(spans: &[Span]) -> Option<(usize, usize)> {
    let mut order: Vec<usize> = (0..spans.len()).collect();
    order.sort_by_key(|&i| spans[i]);
    let mut latest: Option<usize> = None;
    for i in order {
        match latest {
            Some(l) if overlaps(spans[l], spans[i]) => return Some((l.min(i), l.max(i))),
            Some(l) if spans[l].1 >= spans[i].1 => {}
            _ => latest = Some(i),
        }
    }
    None
}

/// The cycle `task → … → task` that making `task` depend on `deps` would close, given the other
/// tasks' dependency edges (task → the tasks it depends on). Breadth-first, so the shortest cycle
/// is reported; `task`'s own stored edges are never followed (they are being replaced).
pub fn dependency_cycle(task: Uuid, deps: &[Uuid], edges: &HashMap<Uuid, Vec<Uuid>>) -> Option<Vec<Uuid>> {
    let mut came_from: HashMap<Uuid, Uuid> = HashMap::new();
    let mut queue = VecDeque::new();
    for &d in deps {
        if d == task {
            return Some(vec![task, task]);
        }
        if came_from.insert(d, task).is_none() {
            queue.push_back(d);
        }
    }
    while let Some(n) = queue.pop_front() {
        for &m in edges.get(&n).into_iter().flatten() {
            if m == task {
                let mut chain = vec![n];
                let mut cur = n;
                while let Some(&p) = came_from.get(&cur) {
                    if p == task {
                        break;
                    }
                    chain.push(p);
                    cur = p;
                }
                chain.reverse();
                let mut path = vec![task];
                path.extend(chain);
                path.push(task);
                return Some(path);
            }
            if let Entry::Vacant(e) = came_from.entry(m) {
                e.insert(n);
                queue.push_back(m);
            }
        }
    }
    None
}

/// Project % complete from its tasks' `(category, progress, expected hours, has sub-tasks)`: only
/// tasks without live sub-tasks count (a parent is its sub-tasks, so nothing counts twice);
/// cancelled tasks are left out, done ones count as 100 %, and each task weighs its expected hours
/// (all weigh the same when none has any).
pub fn weighted_progress(tasks: &[(String, Decimal, Decimal, bool)]) -> Decimal {
    let hundred = Decimal::ONE_HUNDRED;
    let live: Vec<(Decimal, Decimal)> = tasks
        .iter()
        .filter(|(category, _, _, parent)| category != CANCELLED && !parent)
        .map(|(category, p, h, _)| (if category == DONE { hundred } else { (*p).clamp(Decimal::ZERO, hundred) }, (*h).max(Decimal::ZERO)))
        .collect();
    if live.is_empty() {
        return Decimal::ZERO;
    }
    let hours: Decimal = live.iter().map(|t| t.1).sum();
    let pct = if hours.is_zero() {
        live.iter().map(|t| t.0).sum::<Decimal>() / Decimal::from(live.len())
    } else {
        live.iter().map(|(p, h)| p * h).sum::<Decimal>() / hours
    };
    pct.round_dp(2).min(hundred)
}

/// How much of a baseline's plan is due by `today`, 0 to 100, weighed as [`weighted_progress`] weighs progress:
/// each line `(start, end, expected hours)` is due by the share of its days (both ends counted) up to `today`; a line
/// with one date is due all at once on it, one with none takes the baseline's `span`, and one without dates at all
/// counts for nothing.
pub fn planned_percent(lines: &[(Option<NaiveDate>, Option<NaiveDate>, Decimal)], span: (Option<NaiveDate>, Option<NaiveDate>), today: NaiveDate) -> Decimal {
    let hundred = Decimal::ONE_HUNDRED;
    let parts: Vec<(Decimal, Decimal)> = lines
        .iter()
        .filter_map(|(start, end, hours)| {
            let (a, b) = match (start.or(*end), end.or(*start)) {
                (Some(a), Some(b)) => (a, b),
                _ => (span.0?, span.1?),
            };
            if b < a {
                return None;
            }
            let due = if today < a {
                Decimal::ZERO
            } else if today >= b {
                Decimal::ONE
            } else {
                Decimal::from((today - a).num_days() + 1) / Decimal::from((b - a).num_days() + 1)
            };
            Some((due, (*hours).max(Decimal::ZERO)))
        })
        .collect();
    if parts.is_empty() {
        return Decimal::ZERO;
    }
    let hours: Decimal = parts.iter().map(|p| p.1).sum();
    let pct = if hours.is_zero() {
        parts.iter().map(|p| p.0).sum::<Decimal>() / Decimal::from(parts.len()) * hundred
    } else {
        parts.iter().map(|(due, h)| due * h).sum::<Decimal>() / hours * hundred
    };
    pct.round_dp(2).min(hundred)
}

pub fn percent(part: Decimal, whole: Decimal) -> Decimal {
    if whole.is_zero() { Decimal::ZERO } else { (part / whole * Decimal::ONE_HUNDRED).round_dp(2) }
}

/// Timesheet status from its document status and billing.
pub fn timesheet_status(docstatus: i16, billable: Decimal, billed: Decimal) -> &'static str {
    match docstatus {
        0 => "Draft",
        2 => "Cancelled",
        _ if billed > Decimal::ZERO && billed >= billable => "Billed",
        _ if billed > Decimal::ZERO => "Partly Billed",
        _ => "Submitted",
    }
}

/// `(open, overdue, done)` for a task of status category `category` on `today`. Overdue tasks are
/// open ones past their expected end.
pub fn task_bucket(category: &str, exp_end: Option<NaiveDate>, today: NaiveDate) -> (bool, bool, bool) {
    let open = !CLOSED.contains(&category);
    let overdue = open && exp_end.is_some_and(|e| e < today);
    (open, overdue, category == DONE)
}

#[derive(Debug, Clone)]
pub struct BillableLog {
    pub id: Uuid,
    pub activity_type: Uuid,
    pub hours: Decimal,
    pub rate: Decimal,
    /// The day it is on and the day it ends, where the workspace is.
    pub from: NaiveDate,
    pub to: NaiveDate,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimeLine {
    pub activity_type: Uuid,
    pub rate: Decimal,
    pub hours: Decimal,
    pub logs: Vec<Uuid>,
    pub from: NaiveDate,
    pub to: NaiveDate,
}

/// One invoice line per activity type and billing rate, in order of first appearance: time of
/// one activity billed at different (per-user) rates cannot share a line price.
pub fn group_time(logs: &[BillableLog]) -> Vec<TimeLine> {
    let mut out: Vec<TimeLine> = Vec::new();
    for l in logs {
        match out.iter_mut().find(|x| x.activity_type == l.activity_type && x.rate == l.rate) {
            Some(x) => {
                x.hours += l.hours;
                x.logs.push(l.id);
                x.from = x.from.min(l.from);
                x.to = x.to.max(l.to);
            }
            None => out.push(TimeLine { activity_type: l.activity_type, rate: l.rate, hours: l.hours, logs: vec![l.id], from: l.from, to: l.to }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn t(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }
    fn n(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    #[test]
    fn hours_follow_the_span() {
        assert_eq!(hours_between(t("2026-10-26T09:00:00Z"), t("2026-10-26T12:30:00Z")), n("3.5"));
        assert_eq!(hours_between(t("2026-10-26T09:00:00Z"), t("2026-10-26T09:20:00Z")), n("0.333333333"));
        assert_eq!(add_hours(t("2026-10-26T09:00:00Z"), n("1.25")), Some(t("2026-10-26T10:15:00Z")));
        assert_eq!(add_hours(t("2026-10-26T09:00:00Z"), n("1e18")), None, "absurd hours are refused, not panicking");
    }

    #[test]
    fn overlap_detection() {
        let a = (t("2026-10-26T09:00:00Z"), t("2026-10-26T11:00:00Z"));
        let b = (t("2026-10-26T10:30:00Z"), t("2026-10-26T12:00:00Z"));
        let c = (t("2026-10-26T11:00:00Z"), t("2026-10-26T13:00:00Z"));
        assert!(overlaps(a, b) && overlaps(b, a));
        assert!(!overlaps(a, c), "back-to-back spans do not overlap");
        assert_eq!(first_overlap(&[c, a]), None);
        assert_eq!(first_overlap(&[c, b, a]), Some((1, 2)));
        // A long span hides behind a short one that starts later: the sweep still finds it.
        let long = (t("2026-10-26T08:00:00Z"), t("2026-10-26T18:00:00Z"));
        let short = (t("2026-10-26T09:00:00Z"), t("2026-10-26T09:30:00Z"));
        let late = (t("2026-10-26T17:00:00Z"), t("2026-10-26T19:00:00Z"));
        assert_eq!(first_overlap(&[late, short, long]), Some((1, 2)));
        assert_eq!(first_overlap(&[late, long]), Some((0, 1)));
        assert_eq!(first_overlap(&[]), None);
    }

    #[test]
    fn dependency_cycles() {
        let [a, b, c, d] = [Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7()];
        assert_eq!(dependency_cycle(a, &[a], &HashMap::new()), Some(vec![a, a]), "self dependency");
        // b depends on a: a depending on b closes a → b → a.
        let edges: HashMap<Uuid, Vec<Uuid>> = [(b, vec![a])].into_iter().collect();
        assert_eq!(dependency_cycle(a, &[b], &edges), Some(vec![a, b, a]));
        // c → b → a: a depending on c closes a → c → b → a (indirect).
        let edges: HashMap<Uuid, Vec<Uuid>> = [(b, vec![a]), (c, vec![b])].into_iter().collect();
        assert_eq!(dependency_cycle(a, &[d, c], &edges), Some(vec![a, c, b, a]));
        // A diamond is not a cycle.
        let edges: HashMap<Uuid, Vec<Uuid>> = [(b, vec![d]), (c, vec![d])].into_iter().collect();
        assert_eq!(dependency_cycle(a, &[b, c], &edges), None);
        // An existing cycle elsewhere neither loops forever nor counts.
        let edges: HashMap<Uuid, Vec<Uuid>> = [(b, vec![c]), (c, vec![b])].into_iter().collect();
        assert_eq!(dependency_cycle(a, &[b], &edges), None);
    }

    #[test]
    fn progress_is_weighted_by_expected_hours() {
        let task = |s: &str, p: &str, h: &str| (s.to_string(), n(p), n(h), false);
        assert_eq!(weighted_progress(&[]), Decimal::ZERO);
        assert_eq!(weighted_progress(&[task(TO_DO, "50", "10"), task(IN_PROGRESS, "0", "30")]), n("12.5"));
        assert_eq!(weighted_progress(&[task(DONE, "0", "10"), task(TO_DO, "0", "30")]), n("25"), "done counts as 100 %");
        assert_eq!(weighted_progress(&[task(TO_DO, "40", "0"), task(TO_DO, "80", "0")]), n("60"), "no hours: plain average");
        assert_eq!(weighted_progress(&[task(CANCELLED, "0", "100"), task(DONE, "0", "1")]), n("100"), "cancelled tasks do not count");
        assert_eq!(weighted_progress(&[task(TO_DO, "33.333", "1"), task(TO_DO, "0", "2")]), n("11.11"));
        // A parent of 10 hours done at 0 % with two sub-tasks of 10 hours, one done: the parent is its
        // sub-tasks, so it is 50 %, not (0 × 10 + 100 × 10 + 0 × 10) / 30.
        let parent = (TO_DO.to_string(), n("0"), n("10"), true);
        assert_eq!(weighted_progress(&[parent, task(DONE, "0", "10"), task(TO_DO, "0", "10")]), n("50"), "leaves only");
    }

    #[test]
    fn statuses() {
        assert_eq!(timesheet_status(0, n("10"), n("0")), "Draft");
        assert_eq!(timesheet_status(1, n("10"), n("0")), "Submitted");
        assert_eq!(timesheet_status(1, n("0"), n("0")), "Submitted");
        assert_eq!(timesheet_status(1, n("10"), n("4")), "Partly Billed");
        assert_eq!(timesheet_status(1, n("10"), n("10")), "Billed");
        assert_eq!(timesheet_status(2, n("10"), n("10")), "Cancelled");
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let today = day("2026-10-28");
        assert_eq!(task_bucket(TO_DO, Some(day("2026-10-27")), today), (true, true, false));
        assert_eq!(task_bucket(IN_PROGRESS, Some(day("2026-10-28")), today), (true, false, false));
        assert_eq!(task_bucket(TO_DO, None, today), (true, false, false));
        assert_eq!(task_bucket(DONE, Some(day("2026-01-01")), today), (false, false, true));
        assert_eq!(percent(n("1"), n("3")), n("33.33"));
        assert_eq!(percent(n("1"), Decimal::ZERO), Decimal::ZERO);
    }

    #[test]
    fn time_is_grouped_by_activity_and_rate() {
        let (dev, consult) = (Uuid::now_v7(), Uuid::now_v7());
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let log = |a: Uuid, h: &str, r: &str, from: &str, to: &str| BillableLog {
            id: Uuid::now_v7(),
            activity_type: a,
            hours: n(h),
            rate: n(r),
            from: day(from),
            to: day(to),
        };
        let logs = [
            log(dev, "3", "120", "2026-10-26", "2026-10-26"),
            log(consult, "2.5", "150", "2026-10-26", "2026-10-26"),
            log(dev, "2", "120.00", "2026-10-25", "2026-10-25"),
            log(dev, "1", "100", "2026-10-27", "2026-10-27"),
        ];
        let lines = group_time(&logs);
        assert_eq!(lines.len(), 3, "same activity at another rate gets its own line");
        assert_eq!((lines[0].activity_type, lines[0].hours, lines[0].logs.len()), (dev, n("5"), 2));
        assert_eq!((lines[0].from, lines[0].to), (day("2026-10-25"), day("2026-10-26")));
        assert_eq!((lines[1].activity_type, lines[1].rate), (consult, n("150")));
        assert_eq!((lines[2].rate, lines[2].hours), (n("100"), n("1")));
    }

    #[test]
    fn planned_percent_weighs_by_hours() {
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
        let today = day("2026-11-10").unwrap();
        let lines = [(day("2026-11-02"), day("2026-11-09"), n("10")), (day("2026-11-10"), day("2026-11-19"), n("30"))];
        // 10 done, and a tenth of 30: 13 of 40.
        assert_eq!(planned_percent(&lines, (None, None), today), n("32.5"));
    }

    #[test]
    fn planned_percent_counts_alike_without_hours() {
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
        let today = day("2026-11-10").unwrap();
        let lines = [(day("2026-11-01"), day("2026-11-05"), Decimal::ZERO), (day("2026-11-20"), day("2026-11-25"), Decimal::ZERO)];
        assert_eq!(planned_percent(&lines, (None, None), today), n("50"));
    }

    #[test]
    fn a_line_with_one_date_is_a_step() {
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
        let today = day("2026-11-10").unwrap();
        assert_eq!(planned_percent(&[(None, day("2026-11-10"), n("4"))], (None, None), today), n("100"), "due on the day");
        assert_eq!(planned_percent(&[(day("2026-11-11"), None, n("4"))], (None, None), today), Decimal::ZERO, "not yet");
    }

    #[test]
    fn a_line_without_dates_takes_the_span() {
        let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
        let today = day("2026-11-10").unwrap();
        // Days 1 to 10 of a 20-day span.
        let span = (day("2026-11-01"), day("2026-11-20"));
        assert_eq!(planned_percent(&[(None, None, n("8"))], span, today), n("50"));
        assert_eq!(planned_percent(&[(None, None, n("8"))], (None, None), today), Decimal::ZERO, "no span: nothing planned");
    }

    #[test]
    fn nothing_planned_is_zero() {
        let today = NaiveDate::parse_from_str("2026-11-10", "%Y-%m-%d").unwrap();
        assert_eq!(planned_percent(&[], (None, None), today), Decimal::ZERO);
    }
}
