export interface WebhookPayload {
  action?: string;
  comment?: {
    body?: string;
    html_url?: string;
    id?: number | string;
    node_id?: string;
    nodeId?: string;
    url?: string;
  };
  discussion?: {
    body?: string | null;
    id?: string;
    labels?: Array<{ name?: string }>;
    node_id?: string;
    nodeId?: string;
    number?: number | string;
    title?: string;
  };
  issue?: {
    body?: string | null;
    html_url?: string;
    labels?: Array<{ name?: string }>;
    number?: number | string;
    pull_request?: unknown;
    title?: string;
    user?: { login?: string };
  };
  installation?: { account?: { login?: string }; id?: number | string };
  label?: { id?: string | number; name?: string; node_id?: string; nodeId?: string };
  pull_request?: {
    body?: string | null;
    head?: { sha?: string };
    merged?: boolean;
    number?: number | string;
    title?: string;
  };
  review?: {
    body?: string;
    html_url?: string;
    id?: number | string;
    node_id?: string;
    nodeId?: string;
    state?: string;
    url?: string;
  };
  repository?: { name: string; owner: { login: string } };
  repositories?: WebhookRepositoryReference[];
  repositories_added?: WebhookRepositoryReference[];
  sender?: { login?: string; type?: string };
}

export interface WebhookRepositoryReference {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
}
