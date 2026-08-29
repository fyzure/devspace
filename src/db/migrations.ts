import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "process-sessions",
    up: migrateProcessSessions,
  },
  {
    version: 8,
    name: "card-snapshots",
    up: migrateCardSnapshots,
  },
  {
    version: 9,
    name: "card-snapshot-invocations",
    up: migrateCardSnapshotInvocations,
  },
  {
    version: 10,
    name: "unique-card-snapshot-invocations",
    up: migrateUniqueCardSnapshotInvocations,
  },
  {
    version: 11,
    name: "non-unique-card-snapshot-invocations",
    up: migrateNonUniqueCardSnapshotInvocations,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateProcessSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists process_sessions (
      id integer primary key autoincrement,
      workspace_id text not null,
      command text not null,
      working_directory text not null,
      tty integer not null default 0,
      status text not null,
      output text not null default '',
      output_truncated integer not null default 0,
      exit_code integer,
      signal text,
      timed_out integer not null default 0,
      interrupted integer not null default 0,
      started_at integer not null,
      completed_at integer,
      updated_at integer not null
    );

    create index if not exists process_sessions_workspace_idx
      on process_sessions(workspace_id, updated_at desc);

    create index if not exists process_sessions_status_idx
      on process_sessions(status, updated_at desc);
  `);
}

function migrateCardSnapshots(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists card_snapshots (
      id text primary key,
      conversation_scope_id text,
      workspace_id text,
      tool text not null,
      card_json text not null,
      created_at text not null
    );

    create index if not exists card_snapshots_conversation_idx
      on card_snapshots(conversation_scope_id, created_at desc);

    create index if not exists card_snapshots_workspace_idx
      on card_snapshots(workspace_id, created_at desc);
  `);
}

function migrateCardSnapshotInvocations(sqlite: Database.Database): void {
  sqlite.exec(`
    alter table card_snapshots add column request_id text;

    create index if not exists card_snapshots_invocation_idx
      on card_snapshots(conversation_scope_id, request_id);
  `);
}

function migrateUniqueCardSnapshotInvocations(sqlite: Database.Database): void {
  sqlite.exec(`
    delete from card_snapshots
    where conversation_scope_id is not null
      and request_id is not null
      and rowid not in (
        select max(rowid)
        from card_snapshots
        where conversation_scope_id is not null
          and request_id is not null
        group by conversation_scope_id, request_id
      );

    drop index if exists card_snapshots_invocation_idx;

    create unique index if not exists card_snapshots_invocation_idx
      on card_snapshots(conversation_scope_id, request_id);
  `);
}

function migrateNonUniqueCardSnapshotInvocations(sqlite: Database.Database): void {
  sqlite.exec(`
    drop index if exists card_snapshots_invocation_idx;

    create index if not exists card_snapshots_invocation_idx
      on card_snapshots(conversation_scope_id, request_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
