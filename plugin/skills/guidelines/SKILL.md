---
name: guidelines
description: Coding guidelines for apps on the internal platform (React screens, Postgres migrations with row level security, Supabase edge functions, vitest tests). Use when writing, changing or reviewing the code of an app on the platform.
user-invocable: false
---

# Coding guidelines for platform apps

The app's `CLAUDE.md` holds its architecture (stack, folders, auth, deployment); these guidelines say how to write the code inside it. The people who own these apps judge them by using them, not by reading the code: keep it simple enough for another session to change safely.

## Principles

- The simplest code that does what was asked: no option, abstraction or screen nobody asked for.
- No new dependency for what a few lines or the browser do. Add one only for something hard to get right (markdown, charts, dates across time zones), and pick a well-maintained one.
- Name files, functions and types after what the app does (`listNotes`, `ShareDialog`), never `utils`, `helpers` or `manager`.
- Small files: split a screen past about 300 lines into its parts.
- Strict TypeScript without `any`: `unknown` for what comes from outside, then narrow.
- Never swallow an error: tell the user what failed in plain words ("The note could not be saved, try again") and keep the details in the console.
- Comments only for a why the code cannot say (a business rule, a policy's intent), never to narrate the code.

## Screens (React)

- Function components and hooks; state lives in the screen that owns it, lifted only when two screens share it.
- A table's supabase-js calls live in `src/<table>.ts` as named async functions (`listNotes`, `createNote`) that throw the returned `error`. Screens import them, and component tests mock that file.
- Every data call has a loading state and an error state; an empty list says so.
- Accessible markup: a `<label>` for every field, a `<button>` for every action (never a clickable `<div>`), headings in order, `alt` on images. Tests find elements the way users do.
- Never `dangerouslySetInnerHTML` with user content.
- The frontend only has the anon key: anything that needs more goes through a policy or an edge function.

## Database

- One migration per change, named after it (`<timestamp>_share_notes.sql`). A deployed migration is never edited: fix forward with a new one.
- Every table enables row level security in the migration that creates it, and revokes everything from `anon` unless the user wants the data public.
- One policy per command (select, insert, update, delete), `to authenticated`, named after the rule it enforces (`"notes: author can delete"`).
- Compare with `(select auth.uid())` rather than `auth.uid()`: evaluated once per query instead of once per row.
- Every insert and update policy has a `with check`, so nobody writes a row they could not read or hands it to someone else.
- Ownership columns default to `auth.uid()` and an update cannot change them (`with check` or a trigger).
- Foreign keys to users are `on delete cascade` (removing a user must not fail), and every foreign key has an index.
- A function that policies call to read another table is `security definer` with `set search_path = ''`, fully qualified names, and execute revoked from `public` and `anon`.
- Never read `user_metadata` or `raw_user_meta_data` in a policy: users can change it.
- Constraints (`not null`, `check`, `unique`, foreign keys) rather than checks in the frontend; a length limit on free text.
- Files: one bucket per kind of file, created in a migration, with policies on `storage.objects` scoped by bucket and by the owner's folder (`(storage.foldername(name))[1] = (select auth.uid())::text`).

## Edge functions

- Only for what the database cannot do safely: a secret, another service, or a privilege the user does not have.
- Answer `OPTIONS` (CORS) and refuse other unexpected methods with 405.
- Validate the body before using it: 400 with a plain message.
- Identify the caller with a client built from their `Authorization` header (`auth.getUser()`, 401 without a user), then check they may act on the target (403), before anything else.
- The service role client only for the step that needs it, after those checks; never returned, never logged.
- Secrets through `Deno.env.get`, never in the code. Errors as JSON with their status.

## Tests

Vitest, run with `npm test`. It needs the local Supabase running (`supabase start`; `supabase db reset` after a migration change). Deployments run the same tests and stop on a failure.

- **Data tests** (`supabase/tests/<table>.test.ts`, against the local Supabase) prove who sees and changes what: one test per access rule, with the allowed case and the denied ones (another user, a signed-out visitor). They matter most.
- **Component tests** (`src/<Screen>.test.tsx`, jsdom and Testing Library): one per user flow that changed (create, share, choose a password after an invitation), with `src/<table>.ts` mocked.
- **Unit tests** (`src/<module>.test.ts`): pure logic only (formatting, parsing, computing).

How to write them:

- Take the cases from the rules the user asked for, not from the code: a test copied from the code freezes its bugs.
- One test per rule, not per function or branch; cases that differ only by their input share one `it.each`.
- The name states the rule: `it("another user cannot read a private note")`.
- Assert what the user or the caller observes (rows, errors, text on screen), never internals.
- Red first: write the test, see it fail for the right reason, then write the code.
- A failing test is fixed in the code. Change a test only when the rule itself changed.
- Import `describe`, `it`, `expect` and `vi` from `vitest`.

Data tests use the helpers of `supabase/tests/helpers.ts`: `newUser()` for each person in the scenario (never the demo accounts), each acting through their own `client`; `anonClient()` for a signed-out visitor; `adminClient()` only to arrange data no user could create. A read the policies deny returns no rows, a table revoked from `anon` answers `42501`, a denied update or delete changes no row: assert exactly that.

```ts
import { describe, expect, it } from "vitest";
import { anonClient, newUser } from "./helpers";

describe("notes", () => {
  it("only the author reads a private note", async () => {
    const author = await newUser();
    const other = await newUser();
    const { data: note, error } = await author.client.from("notes").insert({ title: "Plan" }).select("id").single();
    expect(error).toBeNull();

    expect((await author.client.from("notes").select("id").eq("id", note!.id)).data).toEqual([{ id: note!.id }]);
    expect((await other.client.from("notes").select("id").eq("id", note!.id)).data).toEqual([]);
    expect((await anonClient().from("notes").select("id")).error?.code).toBe("42501");
  });
});
```

Component tests find elements by role and label, act with `userEvent`, and wait with `findBy...`. Needing a test id means the markup is not accessible: fix the markup.

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NoteList } from "./NoteList";
import { createNote, listNotes } from "./notes";

vi.mock("./notes");

it("creates a note from the empty list", async () => {
  vi.mocked(listNotes).mockResolvedValue([]);
  vi.mocked(createNote).mockResolvedValue({ id: "1", title: "Plan" });
  render(<NoteList />);

  expect(await screen.findByText(/no notes yet/i)).toBeTruthy();
  await userEvent.type(screen.getByLabelText(/title/i), "Plan");
  await userEvent.click(screen.getByRole("button", { name: /add/i }));
  expect(createNote).toHaveBeenCalledWith("Plan");
});
```
