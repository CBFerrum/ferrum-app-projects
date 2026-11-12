-- Projects 0.8.0 (package 0.3.0): a task's status is a record with a category, and a project's tasks go
-- through a workflow of statuses. A workspace already there gets the six statuses it had (with the
-- categories the app gave them) and the Standard workflow holding them, its default, as the package
-- seeds a new one; each task gets the status record of its name and that status's category. Nothing
-- else changes: a task keeps its status name, and Open still turns Overdue when late.
select set_config('ferrum.system', 'on', true);
insert into e_task_status (tenant_id, id, status_name, category, sort_order)
select i.tenant_id, gen_random_uuid(), x.name, x.category, x.ord
from installed_package i
cross join (values ('Open', 'To Do', 1), ('Working', 'In Progress', 2), ('Pending Review', 'In Progress', 3), ('Overdue', 'To Do', 4),
                   ('Completed', 'Done', 5), ('Cancelled', 'Cancelled', 6)) as x(name, category, ord)
where i.name = 'projects'
  and not exists (select 1 from e_task_status s where s.tenant_id = i.tenant_id and s.status_name = x.name);
update e_task_status o set late_status = l.id
from e_task_status l
where o.status_name = 'Open' and o.late_status is null and l.tenant_id = o.tenant_id and l.status_name = 'Overdue';
insert into e_task_workflow (tenant_id, id, workflow_name, is_default)
select i.tenant_id, gen_random_uuid(), 'Standard', true
from installed_package i
where i.name = 'projects'
  and not exists (select 1 from e_task_workflow w where w.tenant_id = i.tenant_id);
insert into e_task_workflow__statuses (tenant_id, id, parent_id, idx, status, category)
select w.tenant_id, gen_random_uuid(), w.id, x.ord - 1, s.id, s.category
from e_task_workflow w
cross join (values ('Open', 1), ('Working', 2), ('Pending Review', 3), ('Overdue', 4), ('Completed', 5), ('Cancelled', 6)) as x(name, ord)
join e_task_status s on s.tenant_id = w.tenant_id and s.status_name = x.name
where w.workflow_name = 'Standard'
  and not exists (select 1 from e_task_workflow__statuses r where r.tenant_id = w.tenant_id and r.parent_id = w.id);
update e_task t set task_status = s.id, status_category = s.category
from e_task_status s
where t.task_status is null and s.tenant_id = t.tenant_id and s.status_name = coalesce(t.status, 'Open');
