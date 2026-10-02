// Platform accounts (journeys A2, A5): admins and app builders, role, activation, password; their apps, tokens and
// audit entries. Deleting an account is refused while it is the last owner of an app.
import { email as isEmail, required, useDataProvider, useRecordContext, useRedirect } from "ra-core";
import {
  BooleanInput,
  Create,
  DataTable,
  Edit,
  List,
  ReferenceManyField,
  SearchInput,
  SelectInput,
  SimpleForm,
  TextInput,
  ToggleFilterButton,
  CreateButton,
} from "@/components/admin";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "./actions";
import { AuditTable } from "./audit";
import { dateTime, StatusBadge } from "./fields";

const ROLES = [
  { id: "developer", name: "developer (app builder)" },
  { id: "admin", name: "admin" },
];

const minPassword = (value: string | undefined) =>
  value && value.length < 12 ? "At least 12 characters" : undefined;

export const UserList = () => (
  <List
    filters={[<SearchInput key="q" source="q" alwaysOn placeholder="Search email or name" />]}
    sort={{ field: "email", order: "ASC" }}
    actions={<CreateButton />}
  >
    <div className="mb-3 flex gap-2">
      <ToggleFilterButton className="w-auto border" label="Admins" value={{ role: "admin" }} />
      <ToggleFilterButton className="w-auto border" label="Builders" value={{ role: "developer" }} />
      <ToggleFilterButton className="w-auto border" label="Disabled" value={{ active: false }} />
    </div>
    <DataTable rowClick="edit" bulkActionButtons={false}>
      <DataTable.Col source="email" />
      <DataTable.Col source="name" />
      <DataTable.Col source="role" render={(u) => <Badge variant={u.role === "admin" ? "default" : "outline"}>{u.role}</Badge>} />
      <DataTable.Col source="active" render={(u) => (u.active ? "yes" : <Badge variant="secondary">disabled</Badge>)} />
      <DataTable.Col source="app_count" label="Apps" />
      <DataTable.Col source="active_token_count" label="Active tokens" />
      <DataTable.Col source="last_token_use" label="Last token use" render={(u) => dateTime(u.last_token_use)} />
      <DataTable.Col source="last_login" label="Last login" render={(u) => dateTime(u.last_login)} />
      <DataTable.Col source="created_at" label="Created" render={(u) => dateTime(u.created_at)} />
    </DataTable>
  </List>
);

export const UserCreate = () => (
  <Create redirect="edit">
    <SimpleForm>
      <TextInput source="email" validate={[required(), isEmail()]} />
      <TextInput source="name" />
      <SelectInput source="role" choices={ROLES} defaultValue="developer" validate={required()} />
      <TextInput source="password" type="password" helperText="Optional: the Studio and admin password (12+ characters)" validate={minPassword} />
    </SimpleForm>
  </Create>
);

const DeleteUserButton = () => {
  const user = useRecordContext();
  const dataProvider = useDataProvider();
  const redirect = useRedirect();
  if (!user) return null;
  return (
    <ActionButton
      label="Delete"
      variant="destructive"
      action={async () => {
        await dataProvider.delete("users", { id: user.id, previousData: user });
        redirect("list", "users");
      }}
      confirm={{
        title: `Delete ${user.email}?`,
        content: "Their sessions, tokens and memberships are deleted; their audit entries stay. Refused while they are the last owner of an app.",
      }}
      successMessage="User deleted"
    />
  );
};

const UserTitle = () => {
  const user = useRecordContext();
  return <span>{user ? String(user.email) : "User"}</span>;
};

const UserRelated = () => {
  const user = useRecordContext();
  if (!user) return null;
  return (
    <div className="mt-8 flex flex-col gap-6">
      <section>
        <h3 className="mb-2 font-semibold">Apps</h3>
        <ReferenceManyField reference="app_members" target="user_id" perPage={100} empty={<p className="text-sm text-muted-foreground">Member of no app.</p>}>
          <DataTable rowClick={(_id, _resource, m) => `/apps/${m.app}/show`} bulkActionButtons={false}>
            <DataTable.Col source="app" />
            <DataTable.Col source="app_name" label="Name" />
            <DataTable.Col source="app_status" label="Status" render={(m) => <StatusBadge status={m.app_status} />} />
            <DataTable.Col source="role" />
          </DataTable>
        </ReferenceManyField>
      </section>
      <section>
        <h3 className="mb-2 font-semibold">Tokens</h3>
        <ReferenceManyField reference="tokens" target="user_id" perPage={100} empty={<p className="text-sm text-muted-foreground">No token.</p>}>
          <DataTable rowClick={false} bulkActionButtons={false}>
            <DataTable.Col source="name" />
            <DataTable.Col source="status" render={(t) => <StatusBadge status={t.status} />} />
            <DataTable.Col source="last_used_at" label="Last used" render={(t) => dateTime(t.last_used_at)} />
            <DataTable.Col source="created_at" label="Created" render={(t) => dateTime(t.created_at)} />
          </DataTable>
        </ReferenceManyField>
      </section>
      <section>
        <h3 className="mb-2 font-semibold">Audit (as actor)</h3>
        <AuditTable target="user_id" />
      </section>
    </div>
  );
};

export const UserEdit = () => (
  <Edit mutationMode="pessimistic" title={<UserTitle />} actions={<DeleteUserButton />}>
    <SimpleForm>
      <TextInput source="email" disabled />
      <TextInput source="name" />
      <SelectInput source="role" choices={ROLES} validate={required()} />
      <BooleanInput source="active" helperText="A disabled account cannot sign in, and its tokens stop working" />
      <TextInput
        source="password"
        type="password"
        label="New password"
        helperText="Leave empty to keep the current one; setting it signs the user out everywhere"
        validate={minPassword}
      />
    </SimpleForm>
    <UserRelated />
  </Edit>
);
