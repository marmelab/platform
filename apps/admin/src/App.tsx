import { Resource } from "ra-core";
import { AppWindow, DatabaseBackup, KeyRound, ScrollText, Settings, ShieldCheck, Users } from "lucide-react";
import { Admin } from "@/components/admin";
import { authProvider, dataProvider } from "./providers";
import { Dashboard } from "./resources/dashboard";
import { LoginPage } from "./resources/login";
import { AppList, AppShow } from "./resources/apps";
import { UserCreate, UserEdit, UserList } from "./resources/users";
import { TokenCreate, TokenList } from "./resources/tokens";
import { AuditList } from "./resources/audit";
import { SsoSettings } from "./resources/sso";
import { BackupList } from "./resources/backups";
import { SettingsPage } from "./resources/settings";

const App = () => (
  <Admin
    title="Platform admin"
    dataProvider={dataProvider}
    authProvider={authProvider}
    loginPage={LoginPage}
    dashboard={Dashboard}
    requireAuth
    disableTelemetry
  >
    <Resource name="apps" list={AppList} show={AppShow} icon={AppWindow} recordRepresentation="slug" />
    <Resource name="users" list={UserList} create={UserCreate} edit={UserEdit} icon={Users} recordRepresentation="email" />
    <Resource name="tokens" list={TokenList} create={TokenCreate} icon={KeyRound} recordRepresentation="name" />
    <Resource name="backups" list={BackupList} icon={DatabaseBackup} />
    <Resource name="audit_log" list={AuditList} icon={ScrollText} options={{ label: "Audit log" }} />
    <Resource name="sso" list={SsoSettings} icon={ShieldCheck} options={{ label: "SSO" }} />
    <Resource name="settings" list={SettingsPage} icon={Settings} options={{ label: "Settings" }} />
    <Resource name="app_members" />
    <Resource name="releases" />
    <Resource name="deployments" />
    <Resource name="secrets" />
    <Resource name="schema_changes" />
  </Admin>
);

export default App;
