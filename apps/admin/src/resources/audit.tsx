// Audit log (journey A3 step 4): every action of the control plane, filterable by app, user and action.
import { DataTable, List, ListPagination, ReferenceInput, AutocompleteInput, ReferenceManyField, SearchInput, TextInput } from "@/components/admin";
import { dateTime } from "./fields";

const Details = ({ details }: { details: unknown }) => {
  if (!details) return null;
  const text = JSON.stringify(details);
  return (
    <code className="block max-w-xl truncate text-xs" title={JSON.stringify(details, null, 2)}>
      {text}
    </code>
  );
};

const AuditColumns = () => (
  <DataTable rowClick={false} bulkActionButtons={false}>
    <DataTable.Col source="created_at" label="When" render={(e) => dateTime(e.created_at)} />
    <DataTable.Col source="user_email" label="Who" render={(e) => e.user_email ?? (e.details?.actor as string | undefined) ?? (
      <span className="text-muted-foreground" title="Admin CLI, CI run, or an account deleted since">no account</span>
    )} />
    <DataTable.Col source="action" />
    <DataTable.Col source="app" render={(e) => e.app ?? "—"} />
    <DataTable.Col label="Details" disableSort render={(e) => <Details details={e.details} />} />
  </DataTable>
);

const auditFilters = [
  <SearchInput key="q" source="q" alwaysOn placeholder="Search action, email, details" />,
  <TextInput key="app" source="app" label="App slug" />,
  <TextInput key="action" source="action" label="Action" />,
  <ReferenceInput key="user" source="user_id" reference="users">
    <AutocompleteInput label="User" />
  </ReferenceInput>,
];

export const AuditList = () => (
  <List filters={auditFilters} sort={{ field: "created_at", order: "DESC" }} perPage={50} actions={false} title="Audit log">
    <AuditColumns />
  </List>
);

/** Audit entries of one app (target "app", the slug) or one user (target "user_id"). */
export const AuditTable = ({ target }: { target: "app" | "user_id" }) => (
  <ReferenceManyField
    reference="audit_log"
    target={target}
    sort={{ field: "created_at", order: "DESC" }}
    perPage={25}
    pagination={<ListPagination />}
  >
    <AuditColumns />
  </ReferenceManyField>
);
