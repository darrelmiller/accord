# Product requirements: Accord

**Status:** Discussion draft, not an approved specification  
**Date:** 2026-10-16  
**Working name:** Accord  
**Scope:** Local-first HTML authoring, asynchronous review, versioning, and web publication

## 1. Purpose

Enable people and agents to create browser-native documents that a designated editor can edit visually, share for asynchronous review, revise through suggested changes, and publish for reading on the web.

Use an ordinary Git repository as the workspace's storage, distribution, access-control boundary, and shared version history. Present document-oriented actions rather than source-control operations.

Documents must coexist with source code and other product assets in existing repositories. A repository need not be dedicated to documents, and adopting the application must not require reorganizing the product repository.

The document content must remain usable without the original authoring application.

## 2. Problem and opportunity

HTML provides an open, expressive presentation format with ubiquitous browser support, but the workflow for editing, sharing, commenting on, and reviewing HTML documents is fragmented. Word and SharePoint combine these activities into a familiar experience; HTML needs a similarly coherent document experience without requiring a proprietary content format.

The initial opportunity is document-centric work: specifications, proposals, research notes, policies, handbooks, and technical reports. Browser presentation takes priority over printed-page layout.

### Hypotheses to validate

These motivate the product; they are not established facts or acceptance criteria:

- Agents can produce better documents in HTML than in Markdown for important target tasks. "Better" needs evaluation for presentation, semantics, accessibility, and editability.
- People will accept a local workspace and installation step for richer editing and review.
- A designated editor plus asynchronous suggestions meets the target workflow without real-time co-editing.
- Git-backed distribution and history can replace enough document-management infrastructure to be attractive.
- Browser-native documents can reduce dependence on Word and SharePoint for the target use cases. Replacing SharePoint's entire enterprise platform is not an initial goal.

## 3. Users and roles

| Role | Responsibilities and needs |
|---|---|
| Editor | Owns authoritative document content; edits visually; requests review; accepts or rejects suggestions; publishes versions. |
| Reviewer | Reads a particular revision; comments, replies, and proposes replacements; explicitly submits a review. Does not directly edit authoritative content. |
| Reader | Opens published content through a normal browser link, without a clone or extension. |
| Agent | Creates or revises HTML and associated assets in an authorized workspace; makes its output available for human editing and review. |

Each document has a designated editor. Ownership transfer and delegation remain open decisions.

Application roles and repository permissions are distinct. Repository write access alone is not an editorial approval mechanism. The product must define its enforcement model before claiming protection against users bypassing the application.

## 4. Product principles

1. **Open content:** HTML and normal web assets are the durable content, not a proprietary application database.
2. **Local-first participation:** Editors and reviewers work from a local repository checkout; reading and drafting reviews work offline after required content is available.
3. **Editorial ownership:** Reviewers propose; the editor decides. No real-time co-editing requirement.
4. **Document vocabulary:** Open workspace, Save, Share, Request review, Submit review, Get reviews, Accept suggestion, Publish, and Version history.
5. **Browser-first presentation:** Optimize for screens, responsive reading, navigation, and links rather than pagination.
6. **Explicit boundaries:** Saving locally, submitting a review, synchronizing remotely, and publishing are separate, visible states.
7. **Progressive enhancement:** The application enriches documents; it must not be required to read their basic content.

## 5. End-to-end experience

1. An agent or person creates an HTML document and its assets in a repository workspace.
2. The editor opens it in the document application and edits the content largely WYSIWYG.
3. The editor saves locally and explicitly shares or requests review of an identifiable revision.
4. A reviewer follows the workspace/document link. The application opens an existing clone or guides authorized acquisition of a local clone.
5. The reviewer navigates linked workspace documents and adds comments or suggested changes, including offline.
6. Submit review publishes the review through an authorized path. Unsubmitted work remains visibly local.
7. The editor retrieves reviews without replacing the working document, then accepts, rejects, or discusses suggestions.
8. The editor compares meaningful versions and publishes an approved snapshot.
9. Readers follow a hosted, read-only link. Review this document can open the corresponding workspace, path, and revision in the installed application.

## 6. Functional requirements

Priority labels describe a proposed sequence, not committed delivery dates.

### 6.1 Workspace and document access

| ID | Priority | Requirement |
|---|---|---|
| WS-01 | Core | Editors and reviewers access content through a local clone of the containing Git repository. The interface must not require manual Git commands. |
| WS-02 | Core | Support multiple HTML documents and ordinary assets in a workspace. Resolve relative links and assets within that workspace. |
| WS-03 | Core | Open an existing workspace or acquire one using the user's authorized repository access. Surface authentication and access failures explicitly. |
| WS-04 | Core | Shareable participation links identify a repository and document path, plus a specific revision when needed. Opening a link must not silently discard local work or change its review baseline. |
| WS-05 | Core | Show the revision being viewed and whether the document is a working draft, review snapshot, or published version. |
| WS-06 | Core | Keep related documents in a consistent workspace revision context. Identify external or unavailable dependencies rather than implying they are present offline. |
| WS-07 | Core | Allow offline reading, editing, and review drafting for available local content. Clearly identify operations that require connectivity. |
| WS-08 | Core | Support documents in mixed-content repositories, including product source-code repositories, without requiring a dedicated repository or fixed document directory. |
| WS-09 | Core | Scope application writes and document operations to intended document content, assets, and explicitly managed metadata. Preserve unrelated files, local modifications, and repository configuration; do not take over the user's existing development workflow. |
| WS-10 | Core | Identify document-specific history and milestones within repository history. Unrelated code changes must not appear as document edits or trigger document publication by themselves. |

The repository is the distribution and initial authorization boundary. Per-document access control within one repository is not required initially.

### 6.2 Agent handoff and visual authoring

| ID | Priority | Requirement |
|---|---|---|
| AU-01 | Core | Open agent-produced HTML and assets for human editing without a required Markdown or Word conversion step. |
| AU-02 | Core | Provide largely WYSIWYG editing of an explicitly supported document profile, including headings, paragraphs, inline emphasis, links, lists, tables, and images. Exact editing operations need specification during design. |
| AU-03 | Core | Preserve supported structure, presentation, links, and metadata through open-edit-save cycles. Do not silently remove unsupported content; warn or offer a read-only path. |
| AU-04 | Core | Persist actual HTML and assets in the workspace, not solely an opaque editor representation. |
| AU-05 | Core | Support undo/redo and recovery of saved local work; make unsaved or unsynchronized state visible. Exact recovery guarantees require definition. |
| AU-06 | Core | Keep application controls and derived navigation out of authored document content. |
| AU-07 | Core | Assign persistent identifiers to addressable sections and content blocks. Preserve identity through ordinary text edits, renames, and moves. |

Arbitrary web applications are not assumed to be editable documents. The supported HTML/CSS profile and treatment of active content are open design decisions.

### 6.3 Structure, navigation, and references

| ID | Priority | Requirement |
|---|---|---|
| NV-01 | Core | Render a dynamic hierarchical TOC in application chrome from document headings/structure. Update it as the document changes without a required authoring build step. |
| NV-02 | Core | Provide section navigation, current-section indication, and copyable links based on persistent identifiers. |
| NV-03 | Core | Support an application sidebar separating document information, contents, review, and reading preferences. Final layout is a UX decision. |
| NV-04 | Follow-on | Allow authors to reference sections and defined terms without manually maintaining generated labels or section numbers. |
| NV-05 | Follow-on | Support citations to related specifications and generated reference lists, including the distinction between a pinned version and a latest-version reference. |
| NV-06 | Follow-on | Preserve citation targets and author intent separately from generated presentation. Report unresolved references. |

ReSpec is conceptual prior art for references, definitions, and generated structure, not a required dependency. A generated TOC need not be stored in the HTML.

### 6.4 Comments and suggested changes

| ID | Priority | Requirement |
|---|---|---|
| RV-01 | Core | Review an identifiable document revision without modifying its authoritative body. |
| RV-02 | Core | Attach comments to a passage, block, or document; support replies and resolved/open state. |
| RV-03 | Core | Propose a text replacement attached to a comment, with a readable before/after preview. |
| RV-04 | Core | Record the review baseline, author attribution, target, original text/context, proposed replacement, and lifecycle state needed to interpret a suggestion. Attribution assurance must be distinguished from an unverified author field. |
| RV-05 | Core | Submit a review explicitly and distinguish local drafts, submitted reviews, and synchronization failures. |
| RV-06 | Core | Retrieve submitted reviews without overwriting the editor's working content or forcing the reviewer to update an in-progress review. |
| RV-07 | Core | Let the editor accept, reject, or discuss a suggestion. Acceptance applies the replacement and records its accepted state as one logical operation. |
| RV-08 | Core | Before applying a suggestion, verify that its target remains applicable. Surface stale, ambiguous, or missing anchors; never blindly apply old offsets. |
| RV-09 | Core | Preserve overlapping suggestions as independent proposals. Accepting one may make another stale; it must not silently accept or discard the other. |
| RV-10 | Core | Support multiple independently submitted reviews without lost or duplicated records, and without requiring concurrent body editing. |
| RV-11 | Core | Permit review records to be persisted inside the HTML, outside the body passages they annotate. A separate sidecar file must not be mandatory. The interoperable encoding is unresolved. |
| RV-12 | Core | Provide an explicit, authorized submission path. Do not assume repository read permission allows review publication. |

Embedded review metadata is a preferred capability, not a settled transport design. The relationship between submitted review records and the editor's embedded records must be specified. Custom elements, Web Annotation selectors, review branches, forks, and services are candidates rather than requirements.

### 6.5 History and comparison

| ID | Priority | Requirement |
|---|---|---|
| HI-01 | Core | Retain recoverable document versions using repository history and expose them without source-control terminology. |
| HI-02 | Core | Distinguish meaningful named review/publication milestones from fine-grained editing history. |
| HI-03 | Core | Select two versions and view a human-readable comparison, with inline and side-by-side modes. |
| HI-04 | Core | Identify added, removed, and changed text. Match sections/blocks by persistent identity so moves can be distinguished from deletion and recreation. |
| HI-05 | Core | Keep generated TOC/numbering/application changes from overwhelming authored-content differences. Do not hide substantive changes merely because they are generated. |
| HI-06 | Follow-on | Provide a changes-since-last-review view that preserves the reviewer's earlier baseline. |
| HI-07 | Follow-on | Provide source-level differences for audit and diagnosis in addition to rendered document differences. |

Detailed comparison behavior for formatting, tables, images, and other assets needs specification before implementation.

### 6.6 Publication and reading

| ID | Priority | Requirement |
|---|---|---|
| PB-01 | Core | Publish an explicitly selected revision as a read-only browser experience requiring neither a clone nor an extension. |
| PB-02 | Core | Provide immutable version-specific URLs and a convenient latest-published URL. Ordinary editing must not silently update a published version. |
| PB-03 | Core | Resolve published relative links and assets within the selected workspace snapshot. |
| PB-04 | Core | Offer navigation, version information, and comparison access in a Datatracker-inspired reading shell where available. Basic content must remain readable without that shell. |
| PB-05 | Core | Distinguish the published version from a newer working draft. A review action must retain the published revision as context. |
| PB-06 | Core | Exclude review records from the public reading artifact by default, with an explicit decision required to publish them. Hiding comments visually is not redaction. |
| PB-07 | Conditional | For private publishing, enforce authorization at the publication surface. Do not assume repository permissions automatically secure deployed files. |
| PB-08 | Follow-on | Preserve a reproducible publication snapshot by retaining the output or pinning relevant rendering tools and external reference data. |
| PB-09 | Core | Publish only explicitly selected document content and dependencies, not the entire repository. Do not expose source code, private review data, or unrelated files merely because they share a repository with a published document. |

Public versus private hosting for the initial release remains open.

### 6.7 Provenance

| ID | Priority | Requirement |
|---|---|---|
| PV-01 | Follow-on | Associate a publication with its source repository revision and declared contributors/agent involvement. Clearly distinguish declarations from verified provenance. |
| PV-02 | Exploration | Evaluate verifiable provenance that remains usable when an artifact leaves its repository, using an open standard where suitable. |
| PV-03 | Exploration | If provenance verification is provided, show its scope, validation status, and effects of subsequent modification without implying that valid provenance proves factual correctness. |

C2PA is a candidate. HTML binding, packaging, verifier support, signing identity, trust policy, and offline behavior must be validated before committing to it. Paragraph-level attribution is not assumed.

## 7. Quality and trust requirements

- **Safety:** Define and enforce a trust boundary for agent-produced and cloned HTML. Document content must not inherit privileged repository, filesystem, or application access. Script and remote-resource policies require explicit design.
- **Reliability:** Failed saves, submissions, fetches, and publication attempts must be visible and recoverable. A remote operation must not destroy unrelated local work.
- **Accessibility:** Editing, navigation, reviewing, and comparison must support keyboard and assistive-technology use. Set a specific conformance target before release.
- **Portability:** Content remains readable with ordinary browsers and repository tools; review metadata must have a documented, versioned representation.
- **Stable persistence:** Unchanged supported content should not be needlessly rewritten on save. Deterministic serialization is desirable; exact formatting rules are a technical design choice.
- **Privacy:** Make clear what is local, remotely submitted, and publicly published. Prevent hidden review data from entering sanitized publication artifacts.
- **Performance:** Establish representative workspace sizes, document lengths, and review volumes before setting measurable latency and resource budgets.
- **Downloaded access:** State that remote revocation does not revoke downloaded copies. Clone/history acquisition can expose reachable older content; administrators must understand that boundary.

## 8. Non-goals for the initial product

- Real-time co-editing or simultaneous modification of authoritative body content.
- Requiring readers of published documents to clone repositories or install software.
- Full fidelity editing of arbitrary HTML applications.
- Print-first layout, pagination, page-number workflows, or Word feature parity.
- Replacing all SharePoint capabilities, such as enterprise search, records management, legal hold, eDiscovery, sensitivity labeling, or tenant administration.
- Requiring single-file packaging of documents and assets.
- Requiring document-only repositories or replacing existing source-code development workflows.
- Choosing jj, a particular editor framework, a browser vendor, a Git host, or a provenance technology in this PRD.
- Automated resolution of all document-body merge conflicts.

## 9. Proposed delivery slices

These organize discovery and implementation; scope remains subject to validation.

| Slice | Outcome |
|---|---|
| 1. Local document experience | Open an existing cloned workspace; visually edit the supported profile; save HTML; navigate linked content with a dynamic sidebar TOC. |
| 2. Editorial review | Pin a review revision; draft and submit comments/suggestions; retrieve them; accept/reject safely; persist embedded review records. |
| 3. History and publication | Named milestones, rendered comparisons, explicit publication, immutable/latest links, and a read-only reading shell. |
| 4. Specification intelligence | Definitions, cross-spec references, bibliographies, reproducible rendering, and provenance experiments. |

Each slice needs its applicable safety and data-integrity requirements; these are not deferred to a final hardening phase.

## 10. Acceptance scenarios

1. **Agent handoff:** An editor opens agent-produced supported HTML, changes a paragraph and table, saves, closes, and reopens. Supported content, assets, links, IDs, and review metadata are preserved; no application controls are saved as content.
2. **Linked workspace:** A reviewer opens a shared revision, follows a relative link to another document, and loads its local images. Both documents remain in that revision context.
3. **Offline review:** A reviewer drafts comments and a replacement offline. Submit review clearly requires connectivity; reconnection and retry deliver one copy without losing the draft.
4. **Suggestion acceptance:** The editor retrieves a suggestion, sees original/proposed text, and accepts it. The intended text and review state change together, with recoverable history.
5. **Stale suggestion:** The editor changes the target before accepting a review. The application identifies the mismatch and requires reconciliation rather than replacing an unrelated range.
6. **Independent reviewers:** Two reviewers submit comments against the same passage. Both arrive intact without changing authoritative content.
7. **Dynamic navigation:** Renaming and moving a section updates the TOC while preserving its identity and links. Comparison identifies the move rather than only a deletion/addition.
8. **Version comparison:** A reader selects two named versions and can inspect inline or side-by-side changes without generated navigation dominating the result.
9. **Publication:** Publishing a selected revision creates an ordinary browser-readable site with working relative assets/links. Later local edits do not alter that snapshot; review records are absent from its delivered source by default.
10. **Permission failure:** A read-authorized reviewer without a valid submission path sees an actionable error, not a false success or unexpected request to modify the main document.
11. **Mixed-content repository:** An editor opens a document alongside product source code and pre-existing local code modifications. Saving, submitting review records, and synchronizing documents preserve that unrelated work. Document history excludes code-only changes, and publication includes only approved document content and dependencies.

## 11. Success measures and validation

Targets are intentionally unset until a baseline study; the product must not invent thresholds from this discussion.

| Question | Evidence to collect |
|---|---|
| Can non-Git users complete the workflow? | Unassisted completion and time for opening, editing, reviewing, accepting, and publishing; occasions requiring Git terminology. |
| Is HTML effective for agent authoring? | Controlled comparison with Markdown-based workflows on representative documents, including presentation, accessibility, correctness, and repair effort. |
| Is persistence trustworthy? | Round-trip fixture results, loss incidents, recovery outcomes, and unauthorized/unintended content changes. |
| Is suggestion handling dependable? | Correct application, stale/ambiguous detection, duplicate delivery, and lost review records. |
| Are comparisons useful? | Reviewer ability to identify substantive changes, moved content, and unintended edits. |
| Is cloning acceptable? | Acquisition time, disk use, installation friction, and abandonment at representative workspace sizes. |

## 12. Open product decisions

- Which initial users and document types define the supported HTML/CSS profile?
- Is the browser extension essential to the experience, or can a companion application's browser surface satisfy it?
- Which repository hosts and operating systems are initially supported?
- What is the authorized review path for readers without repository write permission?
- How do multiple review submissions become embedded records without lost updates?
- Is editorial ownership advisory within a trusted repository, or enforced against direct writes? How are ownership transfers handled?
- Which named milestones and publication states are required?
- Are reviews private by default, and which roles may see them?
- How are document links mapped between local, pinned-revision, and latest-published contexts?
- How are documents and publishable dependencies discovered in mixed-content repositories, and how are document operations isolated from existing development changes and branch workflows?
- Are public publishing, private publishing, or both in the initial scope?
- Which edits and non-text changes can suggestions represent initially?
- What accessibility, performance, recovery, and browser compatibility targets apply?

## 13. Risks and constraints

- Installing a local component and cloning a repository may exclude casual reviewers.
- Repository-level permissions are coarser than document-level sharing; repository organization becomes a product and governance concern.
- Large assets and reachable history increase acquisition cost. Multi-file packaging is simplified, not free.
- In mixed-content repositories, cloning a document workspace can also download product source and history. Repository access remains the boundary; document-only permissions are not implied.
- Document operations can interfere with code development if they move the current checkout or include unrelated modifications. Isolation and coexistence require explicit design.
- Custom review markup may be lost by unrelated HTML editors or sanitizers; interoperability needs explicit testing.
- Rich layout and arbitrary agent-generated markup may exceed what the visual editor can safely round-trip.
- External reference databases can undermine offline operation and reproducibility.
- Published content and source content must have explicit relationships; "both HTML" does not imply identical bytes.
- Open formats enable portability but do not themselves provide identity assurance, governance, or enterprise compliance.

## 14. What belongs outside this PRD

A PRD defines **the problem, users, desired behavior, scope, constraints, and evidence of success**. It can legitimately require HTML and Git because those are deliberate interoperability and distribution boundaries here, not incidental internal libraries.

| Topic discussed | PRD treatment | Better home for detail |
|---|---|---|
| jj | Requirement is simple saving, recovery, history, and synchronization; jj is a candidate implementation. | Technical design and an architecture decision record (ADR). |
| Extension, native helper, local server | Browser editing is required; exact component topology remains unresolved. | Architecture, installation, and security design. |
| Custom tags versus JSON/sidecars | In-file review persistence is supported; exact representation is not selected. | Versioned HTML/review profile specification. |
| Block IDs, offsets, quoted context | Stable identity and safe application are requirements. Exact anchor algorithms are not. | Anchoring protocol and conformance tests. |
| One block per line, attribute ordering | Avoid needless rewriting; exact canonical serialization is an implementation choice. | Serializer design and format specification. |
| Branches, forks, services, merge drivers | Authorized asynchronous review is required. Transport and reconciliation remain undecided. | Review protocol, synchronization design, ADRs. |
| ReSpec | Referencing/navigation capabilities are requirements; the library is not. | Evaluation/prototype and dependency decision. |
| C2PA | Portable verifiable provenance is exploratory; the standard is a candidate. | Feasibility study, trust model, ADR. |
| Datatracker sidebar | A concrete UX reference, not a pixel-for-pixel mandate. | Interaction designs and prototypes. |
| GitHub Pages-like hosting | Read-only publication is required; provider and deployment mechanism are not. | Publication architecture. |
| HTML better than Markdown | Explicit hypothesis, not a requirement or established conclusion. | User research and comparative evaluation. |
| Threat to SharePoint | Strategic motivation, not a testable product requirement. | Product strategy and market analysis. |

## 15. References and discussion provenance

### Initial implementation decision

The selected first slice is a local companion serving a browser application: open an existing repository, navigate HTML documents with a dynamic TOC, edit supported content visually, and save safely. Remote review submission, publication, and provenance are subsequent work. Local files remain authoritative; using HTTP on loopback is a presentation/interaction adapter, not remote document hosting. Direct `file://` editing and a browser extension are not initial requirements. jj remains an implementation candidate, not a dependency requirement.

### Gaps to resolve during initial design

- **External changes and recovery:** Detect edits by agents, other editors, and repository operations; do not overwrite a changed file from a stale browser buffer. Define atomic save, recovery, and multiple-tab behavior.
- **Round-trip contract:** Define supported HTML/CSS and unsupported-content behavior, including paste from other tools, whitespace-sensitive content, accessibility metadata, and preservation of unknown markup.
- **Local trust boundary:** Separate document rendering from privileged application APIs; specify active-content and remote-resource policy, loopback authentication, path containment, and symlink handling. Never execute repository scripts merely to view documents.
- **Development coexistence:** Do not move the user's branch, stage code, or mutate existing development work to operate on documents. Worktree and dependency access need explicit treatment.
- **Identity and review authority:** Decide how editor ownership and reviewer identity are represented and verified; a Git author string is not authentication.
- **Document lifecycle:** Define rename, move, delete, and ownership-transfer behavior so anchors, review links, and history do not silently break.
- **Publication privacy:** Hidden embedded reviews are still in source and Git history; sanitized publication is distinct from granting repository access.
- **Project readiness:** License, distribution/update mechanism, supported platforms, name availability, and a representative end-to-end pilot remain decisions.

This draft captures the exploratory discussion of 2026-10-16. Core directions were expressed during that discussion; delivery slices, default publication privacy behavior, and acceptance scenarios are proposed refinements for approval.

- Datatracker experience reference: https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-11
- ReSpec concepts: https://respec.org/docs/
- W3C Web Annotation Data Model, candidate vocabulary for selectors: https://www.w3.org/TR/annotation-model/
- C2PA, candidate provenance standard; HTML suitability not established here: https://c2pa.org/
- HTML formatting precedent: https://google.github.io/styleguide/htmlcssguide.html#General_Formatting
- Semantic line breaks, related but distinct from block-per-line serialization: https://sembr.org/

Earlier discussion included tentative technical claims about jj, browser APIs, merge behavior, and C2PA. This PRD does not treat them as verified platform guarantees. Technical feasibility must be checked in the corresponding design work.
