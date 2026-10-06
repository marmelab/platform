// Tokens (journeys A2, B1): personal access tokens, whose value is shown once at creation; Claude Code connections
// (a builder signed in from Claude Code through the browser); short-lived deploy tokens restricted to one app. Revoking
// keeps the row for the audit.
import { useState } from "react";
import { required, useNotify } from "ra-core";
import { Copy } from "lucide-react";
import {
  AutocompleteInput,
  Create,
  CreateButton,
  DataTable,
  DateTimeInput,
  List,
  ReferenceInput,
  SearchInput,
  SimpleForm,
  TextInput,
  ToggleFilterButton,
} from "@/components/admin";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dataProvider } from "../providers";
import { ActionButton } from "./actions";
import { dateTime, StatusBadge } from "./fields";

const KIND_LABELS: Record<string, string> = { pat: "PAT", oauth: "Claude Code connection", deploy: "Deploy token" };

export const TokenList = () => (
  <List
    filters={[
      <SearchInput key="q" source="q" alwaysOn placeholder="Search name or email" />,
      <ReferenceInput key="user" source="user_id" reference="users" alwaysOn>
        <AutocompleteInput label="User" className="w-64" />
      </ReferenceInput>,
    ]}
    sort={{ field: "created_at", order: "DESC" }}
    actions={<CreateButton label="New token" />}
  >
    <div className="mb-3 flex gap-2">
      <ToggleFilterButton className="w-auto border" label="Active" value={{ status: "active" }} />
      <ToggleFilterButton className="w-auto border" label="Revoked" value={{ status: "revoked" }} />
      <ToggleFilterButton className="w-auto border" label="PAT" value={{ kind: "pat" }} />
      <ToggleFilterButton className="w-auto border" label="Claude Code" value={{ kind: "oauth" }} />
      <ToggleFilterButton className="w-auto border" label="Deploy" value={{ kind: "deploy" }} />
    </div>
    <DataTable rowClick={false} bulkActionButtons={false}>
      <DataTable.Col source="user_email" label="User" />
      <DataTable.Col source="kind" label="Type" render={(t) => KIND_LABELS[t.kind as string] ?? t.kind} />
      <DataTable.Col source="name" label="Name / client" render={(t) => (t.kind === "deploy" ? `${t.name} (${t.apps ?? "?"})` : t.name)} />
      <DataTable.Col source="status" render={(t) => <StatusBadge status={t.status} />} />
      <DataTable.Col source="last_used_at" label="Last used" render={(t) => dateTime(t.last_used_at)} />
      <DataTable.Col source="created_at" label="Created" render={(t) => dateTime(t.created_at)} />
      <DataTable.Col source="expires_at" label="Expires" render={(t) => dateTime(t.expires_at)} />
      <DataTable.Col
        label=""
        disableSort
        render={(t) =>
          t.status === "active" ? (
            <ActionButton
              label="Revoke"
              variant="outline"
              action={() => dataProvider.delete("tokens", { id: t.id, previousData: t })}
              confirm={t.kind === "oauth"
                ? {
                  title: `Disconnect ${t.name} of ${t.user_email}?`,
                  content: "Its requests are refused at once; to use it again, they must sign in from Claude Code.",
                }
                : { title: `Revoke token "${t.name}" of ${t.user_email}?`, content: "Clients using it are refused at once." }}
              successMessage={t.kind === "oauth" ? "Connection revoked" : "Token revoked"}
            />
          ) : null}
      />
    </DataTable>
  </List>
);

function TokenValue({ token, onDone }: { token: { token: string; name: string; user_email: string }; onDone: () => void }) {
  const notify = useNotify();
  return (
    <Card className="max-w-2xl" data-testid="token-value">
      <CardHeader>
        <CardTitle>Token "{token.name}" created for {token.user_email}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">Copy it now and hand it over privately: it will not be shown again.</p>
        <code className="break-all rounded-md bg-muted p-3 text-sm">{token.token}</code>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => navigator.clipboard.writeText(token.token).then(() => notify("Copied", { type: "info" }))}
          >
            <Copy /> Copy
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export const TokenCreate = () => {
  const [created, setCreated] = useState<{ token: string; name: string; user_email: string } | null>(null);
  if (created) return <TokenValue token={created} onDone={() => (window.location.hash = "#/tokens")} />;
  return (
    <Create redirect={false} mutationOptions={{ onSuccess: (data: { token: string; name: string; user_email: string }) => setCreated(data) }}>
      <SimpleForm>
        <ReferenceInput source="user_id" reference="users">
          <AutocompleteInput label="User" validate={required()} />
        </ReferenceInput>
        <TextInput source="name" validate={required()} helperText="e.g. laptop, claude-code" />
        <DateTimeInput source="expires_at" label="Expires (optional)" />
      </SimpleForm>
    </Create>
  );
};
