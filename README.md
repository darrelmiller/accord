# Accord · local authoring

A working first vertical slice: **local companion + browser UI**, not an
extension. Open an existing Git checkout, discover HTML alongside source code,
read with a Datatracker-inspired information/contents sidebar, visually edit
existing text, save actual HTML, and discuss passages in local review threads.
No account, remote, upload, or publication.

The [canonical product requirements](docs/PRD.html) are semantic HTML and an
editable dogfooding document. They retain the original requirements and the
requirements/implementation distinction, with explicit **Open issues OI-01 to
OI-11**. `PRD.md` is only a pointer, not a divergent specification.

## Run

Requires **Node.js 24+**, npm, Git, and a modern desktop browser.
Development and browser regression tests have been exercised on Windows with
Microsoft Edge; other platforms/browsers are not yet qualified.

```powershell
npm ci
npm run build
npm start
```

Open the **private launch URL** printed by the companion. It binds only
`127.0.0.1` on an OS-assigned port. Enter the absolute path of an existing Git
repository **root** in the sidebar. Both ordinary checkouts and linked Git
worktrees are supported. Do not run this as an administrator.

To use disposable examples instead of your working repository:

```powershell
npm run demo
```

This copies examples, the canonical PRD, and their presentation stylesheet into
a new temporary Git repository and prints its path. Enter that path in Accord.
It is intentionally retained for inspection; remove that specific demo directory
yourself when finished. Start with `examples/handbook.html`, follow its relative
link to `examples/notes/decisions.html`, or select `docs/PRD.html`.
`examples/product-code.ts` is a non-document fixture; it is never exposed or
modified. `examples/unsupported.html` demonstrates inert read-only handling.
`examples/notes/decisions.html.accord-review.json` contains an illustrative local
thread; open the companion notes document and choose Review to inspect it.

Choose **Edit text**, click existing text (including a heading or table cell),
and type. The hierarchical contents list updates immediately. **Save locally**
persists only text changes and missing persistent block IDs. Read mode, text
size, theme, section navigation, current-section indication, path filtering,
and local section-link copying work. Section links contain no authorization
token and work only with this companion/workspace in an already authorized tab;
they are not portable review or publication links.

Optional fixed port, for a trusted local workflow:

```powershell
$env:ACCORD_PORT = "4318"
npm start
```

Stop the companion with Ctrl+C. A restart requires its new launch URL.

## Local reviewing and comments

Choose **Review** to keep document text read-only while discussing it. Enter a
display name (explicitly **unverified**), select a passage within one text block
or click the block, and write a comment. Keyboard users can Tab to a document
block and press Enter to target it and focus the composer. **Use whole document**
removes the passage anchor. Save comments locally, reply to threads, resolve/reopen them,
toggle resolved threads, and jump back to matched passages. Open anchored
threads highlight their target blocks. This is a local discussion, **not a
submitted review or authenticated approval**.

New discussions live beside the HTML, for example
`examples/handbook.html.accord-review.json`. This **provisional sidecar choice**
keeps document and review-only Git changes separate, allows comments without
rewriting HTML, and reduces accidental disclosure when sharing only the HTML.
The tradeoff: copy or rename the pair together or the comments are left behind.
Embedded comments would travel with a single file but mix private discussion
into document source. Existing embedded JSON records remain byte-for-byte
untouched; no automatic import, export, or migration is claimed. The canonical
PRD records the tradeoff and the still-open long-term choice in OI-08.

Each thread stores its baseline document SHA-256, quoted passage, optional block
ID, author declaration, timestamps, replies, and open/resolved status in
`schemaVersion: 1` JSON. Never assume a display name proves identity. An old
baseline alone does not invalidate an unchanged quote: anchors are checked
against their block, with changed/ambiguous/missing targets clearly labelled.
Only matched anchors offer passage navigation; stale discussions are retained,
not discarded or silently reassigned.

Passage comments require a **persisted unique ID in the source HTML**, not a
preview-only provisional ID. If the source lacks IDs, use a whole-document
comment or assign IDs in your source editor first. Review never modifies HTML
merely to create an anchor. Repeated quoted text in the same block is ambiguous
and must be narrowed to a unique passage or reviewed at document level.

Starting Review reloads disk after resolving any unsaved text edits. A changed
document rejects a new comment against the stale baseline. A changed sidecar
rejects a stale comment/reply/status write rather than losing other discussions.
**Refresh comments** reloads the sidecar without clearing the current draft;
retry after checking it. Text and review drafts share the unsaved-navigation
guard. Drafts are tab-local until explicitly saved and do not survive a crash.
The display name is remembered only in that tab's session storage.

Sidecars are limited to 2 MiB, 500 threads, 200 replies per thread, and 2,000
total messages. Bodies are limited to 10,000 characters; the UI limits display
names to 120 and selected quotes to 10,000 characters (the storage schema permits
200 and 100,000 respectively). Unknown JSON fields and unsupported schema
versions are rejected, not silently removed.

Review writes use flushed staging files, fingerprint rechecks, and atomic
rename, but **do not create review backups or history**. The HTML recovery
copies described below do not back up sidecars. Interrupted locks require
inspection; abandoned review staging files are not automatically recovered.
Use your own backup/version-control workflow to retain earlier discussions.

Review sidecars contain private discussion in cleartext and become visible to
anyone with filesystem/repository access, including Git history if committed.
They are not a security boundary. Do not publish a repository directory as a
site. Review mode does not change staging, commits, branches, HTML, or assets.
Remote submission, suggestions/acceptance, editor-policy authorization, and
automatic pair renames remain deferred.

## Editing and round-trip contract

This is deliberately **text editing within existing structure**, not a general
rich-text editor. It supports explicit, well-formed UTF-8 HTML documents with
headings, paragraphs, emphasis, links, lists, tables, captions, images, and
ordinary semantic containers. Existing formatting and attributes stay fixed.
Inline text runs are separately editable; adding/removing/moving blocks,
formatting, link targets, table structure, and image replacement require a
source editor. Enter/new blocks, multi-line paste, and drag/drop are disabled;
single-line paste is plain text. Native browser undo/redo applies **before Save**; Save/reload resets
the browser editing history.

The parser records source offsets. Saves escape replacements and patch those
ranges, **not a serialization of the preview DOM**. Unchanged source bytes,
comments, whitespace, attributes, existing IDs, relative links, asset files,
head metadata, and embedded `application/json` records remain untouched.
On a meaningful save, missing IDs on headings/addressable text blocks are
inserted once; no-op saves leave the entire file unchanged. JSON records are
counted but not interpreted, authenticated, submitted, or rewritten.

Unknown elements/attributes, active scripts/handlers, duplicate IDs, parse
errors, repaired source ordering, and documents without explicit html/body
boundaries are **read-only**, with a reason. Previewing is not a fidelity claim:
unknown markup is reduced to inert text or omitted, and **original CSS is
preserved on disk but never applied in the application**. The exact, fixed
Clawpilot theme bootstrap used by our standalone samples is an opaque,
source-preserved exception; it is never executed in the preview. Other active
scripts make the document read-only. The supported tag/attribute lists and
validation rules live in `server/document.ts`.

Relative links work only between discovered HTML documents in the selected
workspace. Relative PNG/JPEG/GIF/WebP assets are signature-checked, embedded as
data URLs in the preview, and never rewritten. External/root-relative links,
remote images, SVG, CSS imports, forms, embedded pages, and repository scripts
are not activated. Missing/blocked local image errors are visible. No external
network resource is required for reading or editing available documents.

## Persistence, conflicts, and recovery

- Every load returns a SHA-256 disk fingerprint. Save rejects a changed baseline
  with HTTP 409, retains the browser draft, and requires explicit reconciliation.
  **Copy your draft text before discarding/reloading**; automatic merge is not
  implemented. Unsaved navigation offers Keep editing / Discard / Save and
  continue. Closing/reloading the tab uses the browser's unsaved-change warning.
- Saves are serialized per companion and use an exclusive per-document lock
  across companion instances. Workspace IDs prevent an old tab from saving
  into a workspace switched by another tab. Text editing is frozen while a
  request is in progress so late keystrokes cannot be lost behind a save.
- The replacement is written to an exclusive sibling temporary file, flushed,
  checked again against disk identity/content, then atomically renamed. Failed
  saves return explicit errors; temporary files are cleaned up. Previous bytes
  are flushed to a private `accord-recovery-*` directory under the OS temp
  directory before replacement. The successful Save message shows the exact
  recovery file path. Restore it manually with an ordinary file tool after
  closing the document; there is no recovery browser or automatic restore.
- A crashed process can leave a sibling `.accord-*.lock`/`.tmp` file. A lock is
  **never silently broken**: the error gives its exact path. Confirm no companion
  is saving that document before manually removing that specific stale lock.
  Recovery files can contain private reviews and are not auto-expired or
  encrypted; OS temp cleanup may remove them. They are not a durable version
  history or unsaved-draft backup.

**Concurrency boundary:** ordinary external edits and stale tabs are detected.
Portable Node filesystem APIs do not provide a compare-and-swap rename against
non-cooperating writers: a last-check-to-rename race remains with simultaneous
external writes or malicious path replacement. This is not an OS-level sandbox
against another process that can already write your files. Do not use it while
untrusted processes are mutating the checkout. Full cross-process transactions,
power-loss/directory durability, ACL/xattr preservation, and unsaved crash
recovery remain OI-01/OI-03 decisions, not claimed guarantees.

## Local trust boundary

The browser shell is the privileged surface; document source is not installed
in that shell. A sanitized semantic preview runs in a separate **sandboxed
iframe without `allow-scripts`**, with a deny-by-default CSP and no document
scripts, handlers, forms, custom elements, author styles, remote requests,
popups, or top navigation. Same-origin access is permitted only so the trusted
parent can operate the text-editing DOM. Never add `allow-scripts` to this frame.
The parent communicates with the companion; document code never gets an API
capability. App chrome and derived navigation are not part of save data.

The random per-process capability is supplied in the launch URL fragment,
removed from the address bar, and kept in the privileged tab's sessionStorage.
All APIs require its Bearer header. Modifying APIs additionally require the
exact loopback Origin and JSON content type; Host is pinned to the actual
loopback address/port, and no CORS grant is provided. The application rejects
cross-site requests and DNS-rebinding Host names. Treat the launch URL as a
local secret; it is not repository/editor authentication or a multi-user server.

The companion never serves a repository static root. Discovery skips hidden
paths (including `.git`), `node_modules`, `vendor`, `dist`, `build`, `coverage`,
and symlinks/junctions. Only discovered `.html`/`.htm` files, their associated
review sidecars through schema-validated review APIs, and their explicitly
referenced supported raster images can be read. Absolute paths, traversal,
alternate streams, Windows device names, hard-linked file reads, and symlink
components are rejected, with containment rechecked on use. No asset-write,
arbitrary-file, Git mutation, repository-build, or command-execution endpoint
exists. Git is used only for a read-only repository-root check with optional
locks and fsmonitor disabled.

Guardrails: 2 MiB per HTML/image, 8 MiB combined preview images, 2,000 HTML
documents, 30,000 discovered non-excluded entries, 32 directory levels, and a
3 MiB modifying-request body. These are prototype guardrails, not measured
product performance targets. Reopen the workspace to rediscover new files.

## Stack and layout

**TypeScript + Node's HTTP/filesystem APIs + vanilla browser DOM** keep this
single-screen local prototype inspectable and small. `parse5` is the sole
runtime dependency: browser-compatible parsing with source locations avoids
inventing an HTML parser or rewriting unknown source. A component framework,
bundler, CSS framework, or rich-text schema engine would add complexity without
improving this bounded text-only profile. The UI uses Clawpilot theme variables,
system typography, and no remote fonts/CDNs. TypeScript and Playwright are
development-only tools.

| Path | Purpose |
| --- | --- |
| `server/` | Loopback authentication, path containment, discovery, HTML profile, save protocol |
| `ui/` | Trusted shell, isolated reading/editing controller, theme |
| `shared/` | Typed transport shapes and fixed theme bootstrap |
| `docs/PRD.html` | Single canonical product specification; editable dogfood |
| `examples/` | Linked HTML, a relative image, inert unsupported HTML, non-document code |
| `tests/`, `browser-tests/` | Disposable-fixture API/persistence and actual-browser regressions |

## Verify

```powershell
npm test
npm run test:browser
```

Both commands run strict TypeScript builds. Focused Node tests cover source
preservation, stable IDs, unsupported/malformed HTML, injection escaping,
relative resolution, Git/code coexistence, recovery, stale saves, competing
companions, traversal/junction/hard-link containment, encoding/size limits,
raster validation, and API capability/Host/Origin/workspace protection.
Browser tests exercise actual visual edits, TOC updates, linked navigation,
native undo, plain-text paste, save-time freezing, unsaved prompts, conflicts,
inert read-only content, reading preferences, and PRD dogfooding.
Tests create temporary Git repositories; they never use real user checkouts.

Review regressions cover sidecar-only persistence, passage and whole-document
anchors, replies and resolution, unsaved-comment navigation, concurrent/stale
writes, malformed/unsupported schemas, stale/missing anchors, untrusted comment
text, and document-byte preservation.

Browser tests default to installed Edge. For another supported Playwright
channel, set `ACCORD_BROWSER_CHANNEL`. If Edge is unavailable, explicitly
install Playwright Chromium and select it:

```powershell
npx playwright install chromium
$env:ACCORD_BROWSER_CHANNEL = "chromium"
npm run test:browser
```

## Explicitly deferred

No repository acquisition, policy enforcement, authenticated editorial
identity, replacement suggestions/acceptance UI, remote review submission, synchronization,
history/versions UI, hosted publication, C2PA, reference database integration,
real-time co-editing, or full rich-text feature parity. There are no fake
buttons for these capabilities. There is no jj dependency.

The product direction is repository-owned, path-based editor policy inspired
by CODEOWNERS. Filename/syntax, precedence, default owner, delegation, transfer,
trusted-baseline evaluation, self-authorization resistance, and application
versus host enforcement are **open (OI-06)**; local filesystem permission is
not presented as editorial authorization. Public/private publishing,
confidential review redaction (including repository history), install/update,
licensing, naming, accessibility conformance, browser matrix, and measured
performance targets remain explicit PRD decisions.
