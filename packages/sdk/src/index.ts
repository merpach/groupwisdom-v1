const DEFAULT_BASE_URL = "https://testgroupwisdom.com";

export interface GroupWisdomOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
  webhook_url: string | null;
  webhook_secret?: string;
  counts: { items: number; wisdom: number; /** @deprecated same value as `wisdom` */ insights: number };
}

export interface IngestItem {
  title?: string;
  content?: string;
  url?: string;
  type?: "link" | "note" | "file" | "thought";
  contributed_by?: string;
}

export interface IngestResponse {
  accepted: number;
  items: Array<{ id: string; title: string; type: string }>;
  message: string;
}

export interface Item {
  id: string;
  group_id: string;
  member_id: string | null;
  type: string;
  title: string;
  content: string;
  url: string;
  source: string;
  created_at: string;
}

/**
 * The six kinds of wisdom the engine surfaces. All six describe what a group
 * is building, never what it is failing to do.
 */
export type WisdomKind =
  | "convergence"   // two people reached the same finding from different directions
  | "opportunity"   // something their own work points at that nobody has picked up
  | "tension"       // two views worth putting together, stated as the actual difference
  | "pattern"       // a theme across several contributions none of them named
  | "direction"     // the next question their work is building toward
  | "decision"      // something they have arrived at, and what led there
  | "handoff";      // finished work by someone else, handed to a person as they start on a task

/** Simple wisdom — the default API response */
export interface Wisdom {
  id: string;
  title: string;
  body: string;
}

/** Full wisdom — returned when format: "full" is passed */
export interface WisdomFull extends Wisdom {
  kind: WisdomKind;
  status: string;
  created_at: string;
  confidence: "high" | "medium" | "low" | null;
  /** A completed result from another member that the reader now has for free. */
  do_next: string | null;
  /** A condition under which this would not hold. */
  caveat: string | null;
  /** A contributor whose existing work would strengthen this. */
  missing_voice: string | null;
  /** The words the finding rests on, copied from a contribution and verified against it. */
  stated_in: string | null;
  /** The channel the finding was drawn for, when items carry one. */
  channel: string | null;
}

/** One decision by the engine: why it spoke, or why it stayed quiet. */
export interface GateRecord {
  id: string;
  stage: "scan" | "review" | "memory" | "handoff";
  verdict: "silent" | "spoken" | "suppressed" | "error" | "dropped";
  kind: string | null;
  title: string | null;
  reason: string | null;
  insight_id: string | null;
  created_at: string;
}

/** What the engine currently believes the project has established. */
export interface ProjectMemory {
  purpose: string;
  facts: Array<{ fact: string; by: string; sources: string[] }>;
  decisions: Array<{ decision: string; sources: string[] }>;
  open_questions: string[];
}

export interface UsageStatus {
  /** Share of the account's analysis allowance used, across every project. */
  percent_used: number;
  limit_reached: boolean;
}

export type FeedbackVerdict = "helpful" | "wrong" | "late";

export interface FeedbackRow {
  id: string;
  insight_id: string;
  member: string;
  verdict: FeedbackVerdict | string;
  source_event_id: string | null;
  withdrawn: number;
  created_at: string;
}

/** @deprecated Use {@link WisdomKind}. */
export type InsightKind = WisdomKind;
/** @deprecated Use {@link Wisdom}. */
export type Insight = Wisdom;
/** @deprecated Use {@link WisdomFull}. */
export type InsightFull = WisdomFull;

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ProjectApiKey {
  id: string;
  name: string;
  key: string;
  created_at: string;
}

export interface ProjectApiKeyPreview {
  id: string;
  name: string;
  key_preview: string;
  created_at: string;
  last_used_at: string | null;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface WisdomListOptions extends PaginationOptions {
  format?: "full";
}

/** @deprecated Use {@link WisdomListOptions}. */
export type InsightListOptions = WisdomListOptions;

class GroupWisdom {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: GroupWisdomOptions) {
    if (!options.apiKey) throw new Error("GroupWisdom: apiKey is required.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/v1${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const data = await res.json() as any;

    if (!res.ok) {
      throw new Error(`GroupWisdom API error ${res.status}: ${data?.error ?? res.statusText}`);
    }

    return data as T;
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  /** Create a new project. Requires personal API key. */
  createProject(name: string, options?: { webhook_url?: string }): Promise<Project> {
    return this.request("POST", "/projects", { name, ...options });
  }

  /** List all projects you have access to. Requires personal API key. */
  listProjects(): Promise<Project[]> {
    return this.request("GET", "/projects");
  }

  /** Get a single project by ID. */
  getProject(projectId: string): Promise<Project> {
    return this.request("GET", `/projects/${projectId}`);
  }

  /**
   * Update a project's webhook URL. Returns the project with webhook_secret
   * included — store this secret to verify incoming webhook signatures.
   */
  updateProject(projectId: string, updates: { webhook_url?: string | null; engine?: "claude" | "muse-spark" }): Promise<Project> {
    return this.request("PATCH", `/projects/${projectId}`, updates);
  }

  /** Delete a project with everything in it. Requires personal API key. Cannot be undone. */
  deleteProject(projectId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request("DELETE", `/projects/${projectId}`);
  }

  /**
   * Trigger a full re-analysis of the project now. Returns once the request
   * is accepted; the analysis runs in the background and reaches your webhook
   * or listWisdom. Limited to one per project every few minutes (429 with
   * Retry-After inside the window).
   */
  analyze(projectId: string): Promise<{ message: string }> {
    return this.request("POST", `/projects/${projectId}/analyze`);
  }

  /**
   * Send a signed sample event to the project's webhook URL right now, and
   * report the status your endpoint returned.
   */
  testWebhook(projectId: string): Promise<{ sent: boolean; status?: number; error?: string }> {
    return this.request("POST", `/projects/${projectId}/test-webhook`);
  }

  // ── The engine's own account of itself ──────────────────────────────────────

  /**
   * Why the engine spoke, or why it stayed quiet: every decision, newest
   * first. The first thing to read when a project seems too quiet.
   */
  async getGateRecords(projectId: string, options?: { limit?: number }): Promise<GateRecord[]> {
    const r = await this.request<{ records: GateRecord[] }>("GET", `/projects/${projectId}/gate-records${buildQS(options)}`);
    return r.records;
  }

  /** What the engine currently believes the project has established. Null before anything has accumulated. */
  async getMemory(projectId: string): Promise<{ memory: ProjectMemory | null; updated_at: string | null }> {
    return this.request("GET", `/projects/${projectId}/memory`);
  }

  /** How much of the account's analysis allowance is used. Requires personal API key. */
  getUsage(): Promise<UsageStatus> {
    return this.request("GET", "/usage");
  }

  // ── Feedback ────────────────────────────────────────────────────────────────

  /**
   * Record what a reader made of a finding. Pass source_event_id when your
   * source has one (a reaction id, say) so the verdict can be withdrawn later.
   */
  giveFeedback(wisdomId: string, verdict: FeedbackVerdict, options?: { member?: string; source_event_id?: string }): Promise<{ recorded: boolean; verdict: FeedbackVerdict }> {
    return this.request("POST", `/wisdom/${wisdomId}/feedback`, { verdict, ...options });
  }

  /** Withdraw a verdict by the source_event_id it was recorded with. */
  withdrawFeedback(sourceEventId: string): Promise<{ withdrawn: boolean }> {
    return this.request("DELETE", `/wisdom/feedback/${encodeURIComponent(sourceEventId)}`);
  }

  /** A project's verdicts and their totals. */
  listFeedback(projectId: string, options?: { limit?: number }): Promise<{ summary: Record<string, number>; feedback: FeedbackRow[] }> {
    return this.request("GET", `/projects/${projectId}/feedback${buildQS(options)}`);
  }

  /**
   * Merge everything filed under one contributor name into another, for work
   * that arrived before you knew someone's real name.
   */
  renameContributor(projectId: string, from: string, to: string): Promise<{ renamed: boolean } & Record<string, unknown>> {
    return this.request("POST", `/projects/${projectId}/rename-contributor`, { from, to });
  }

  // ── Ingest ──────────────────────────────────────────────────────────────────

  /**
   * Send one or more items to a project. Triggers analysis automatically.
   * Each item can include contributed_by to attribute it to a specific person.
   */
  ingest(projectId: string, items: IngestItem | IngestItem[]): Promise<IngestResponse> {
    const payload = Array.isArray(items) ? { items } : items;
    return this.request("POST", `/projects/${projectId}/ingest`, payload);
  }

  // ── Items ────────────────────────────────────────────────────────────────────

  /** List items in a project. Returns paginated results. */
  listItems(projectId: string, options?: PaginationOptions): Promise<PaginatedResult<Item>> {
    const qs = buildQS(options);
    return this.request("GET", `/projects/${projectId}/items${qs}`);
  }

  /** Delete an item from a project. */
  deleteItem(projectId: string, itemId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request("DELETE", `/projects/${projectId}/items/${itemId}`);
  }

  // ── Wisdom ──────────────────────────────────────────────────────────────────

  /**
   * Get the wisdom a project has surfaced. Returns paginated results.
   * Default: { id, title, body } only.
   * Pass format: "full" to also get kind, status, created_at, confidence,
   * do_next, caveat and missing_voice.
   * Optionally filter by kind: convergence | opportunity | tension | pattern | direction | decision
   */
  listWisdom(projectId: string, kind?: WisdomKind, options?: WisdomListOptions & { format: "full" }): Promise<PaginatedResult<WisdomFull>>;
  listWisdom(projectId: string, kind?: WisdomKind, options?: WisdomListOptions): Promise<PaginatedResult<Wisdom>>;
  listWisdom(projectId: string, kind?: WisdomKind, options?: WisdomListOptions): Promise<PaginatedResult<Wisdom | WisdomFull>> {
    const qs = buildQS({ ...options, ...(kind ? { kind } : {}) });
    return this.request("GET", `/projects/${projectId}/wisdom${qs}`);
  }

  /**
   * @deprecated Renamed to {@link listWisdom}. This still calls the API and
   * returns the same data, so existing code keeps working unchanged.
   */
  listInsights(projectId: string, kind?: WisdomKind, options?: WisdomListOptions & { format: "full" }): Promise<PaginatedResult<WisdomFull>>;
  listInsights(projectId: string, kind?: WisdomKind, options?: WisdomListOptions): Promise<PaginatedResult<Wisdom>>;
  listInsights(projectId: string, kind?: WisdomKind, options?: WisdomListOptions): Promise<PaginatedResult<Wisdom | WisdomFull>> {
    return this.listWisdom(projectId, kind, options as WisdomListOptions);
  }

  // ── Project API Keys ─────────────────────────────────────────────────────────

  /**
   * Create a scoped API key for a project.
   * The returned key is only shown once — store it securely.
   * Requires personal API key.
   */
  createKey(projectId: string, name: string): Promise<ProjectApiKey> {
    return this.request("POST", `/projects/${projectId}/keys`, { name });
  }

  /** List API keys for a project (keys are redacted). Requires personal API key. */
  listKeys(projectId: string): Promise<ProjectApiKeyPreview[]> {
    return this.request("GET", `/projects/${projectId}/keys`);
  }

  /** Revoke a project API key. Requires personal API key. */
  revokeKey(projectId: string, keyId: string): Promise<{ revoked: boolean; id: string }> {
    return this.request("DELETE", `/projects/${projectId}/keys/${keyId}`);
  }
}

function buildQS(params?: Record<string, any>): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

export default GroupWisdom;
