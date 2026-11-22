/** Ordered, visible members, rebuilt from their owning facts. All SQL here is
 * static. In particular the trigger bodies need no application SQL functions. */
export type WorksetKind = "folder" | "folder-tree" | "intake" | "discovery";

const active = (kind: string, id: string) =>
  "NOT EXISTS(SELECT 1 FROM intake_withdrawn_objects w WHERE w.object_kind='" +
  kind +
  "' AND w.object_id=" +
  id +
  ")";
const alive = (id: string) => active("literature", id);
const topic = "topic_discovery_causes";
const citation = "citation_discovery_causes";
const results = "discovery_results";

export function refreshFolderMembers(owners: string) {
  return [
    "DELETE FROM library_ordered_members WHERE kind IN ('folder','folder-tree') AND literature_id IN (" +
      owners +
      ")",
    "INSERT INTO library_ordered_members(kind,scope_id,literature_id,intake_at) " +
      "WITH RECURSIVE direct(literature_id,folder_id) AS (" +
      "SELECT m.literature_id,m.folder_id FROM (" +
      owners +
      ") keys CROSS JOIN folder_members m ON m.literature_id=keys.literature_id " +
      "JOIN folders f USING(folder_id) WHERE " +
      alive("m.literature_id") +
      " AND " +
      active("folder", "m.folder_id") +
      " AND " +
      active("folder-member", "json_array(m.folder_id,m.literature_id)") +
      " GROUP BY m.literature_id,m.folder_id), " +
      "ancestors(literature_id,folder_id) AS (SELECT * FROM direct UNION " +
      "SELECT a.literature_id,p.folder_id FROM ancestors a JOIN folders f ON f.folder_id=a.folder_id JOIN folders p ON p.folder_id=f.parent_id) " +
      "SELECT 'folder',d.folder_id,d.literature_id,i.intake_at FROM direct d LEFT JOIN literature_intake i USING(literature_id) UNION ALL " +
      "SELECT 'folder-tree',a.folder_id,a.literature_id,i.intake_at FROM ancestors a LEFT JOIN literature_intake i USING(literature_id)",
  ];
}

function refreshMembers(
  kind: "intake" | "discovery",
  keys: string,
  match: string,
) {
  return [
    // Include kind in the tuple so SQLite seeks the full key even for compound
    // SELECTs. A separate kind predicate makes SQLite scan that whole range.
    `DELETE FROM library_ordered_members WHERE (kind,scope_id,literature_id) IN (
       SELECT '${kind}',scope_id,literature_id FROM (${keys}))`,
    "INSERT INTO library_ordered_members(kind,scope_id,literature_id,intake_at) " +
      "SELECT '" +
      kind +
      "',k.scope_id,k.literature_id,i.intake_at FROM (" +
      keys +
      ") k " +
      "LEFT JOIN literature_intake i ON i.literature_id=k.literature_id " +
      "WHERE " +
      alive("k.literature_id") +
      " AND (" +
      match +
      ") " +
      "ON CONFLICT(kind,scope_id,literature_id) DO UPDATE SET intake_at=excluded.intake_at",
  ];
}

function insertVisibleMember(
  kind: "intake" | "discovery",
  scope: string,
  literature: string,
  visible = alive(literature),
) {
  return `INSERT INTO library_ordered_members(kind,scope_id,literature_id,intake_at)
    SELECT '${kind}',${scope},${literature},
      (SELECT intake_at FROM literature_intake WHERE literature_id=${literature})
    WHERE ${visible}
    ON CONFLICT(kind,scope_id,literature_id) DO UPDATE SET intake_at=excluded.intake_at
    WHERE intake_at IS NOT excluded.intake_at`;
}

export const refreshIntakeMembers = (keys: string) =>
  refreshMembers(
    "intake",
    keys,
    "EXISTS(SELECT 1 FROM intake_batch_members m WHERE m.batch_id=k.scope_id AND m.literature_id=k.literature_id)",
  );
export const refreshDiscoveryMembers = (keys: string) =>
  refreshMembers(
    "discovery",
    keys,
    "EXISTS(SELECT 1 FROM " +
      topic +
      " c WHERE c.discovery_run_id=k.scope_id AND c.actual_literature_id=k.literature_id) OR " +
      "EXISTS(SELECT 1 FROM " +
      citation +
      " c WHERE c.discovery_run_id=k.scope_id AND c.actual_literature_id=k.literature_id AND " +
      alive("c.source_literature_id") +
      " AND " +
      alive("c.target_literature_id") +
      ")",
  );

const kindSql = (id: string) =>
  "(SELECT kind FROM discovery_runs WHERE discovery_run_id=" + id + ")";
const hasResult = (c: string) =>
  "EXISTS(SELECT 1 FROM discovery_results r WHERE r.discovery_run_id=" +
  c +
  ".discovery_run_id AND r.meta_literature_id=" +
  c +
  ".meta_literature_id)";
export const invalidTopicCause = (
  c: string,
  kind = kindSql(c + ".discovery_run_id"),
) =>
  "(" +
  kind +
  " IS NOT 'topic' OR NOT " +
  hasResult(c) +
  " OR NOT EXISTS(SELECT 1 FROM literature_metadata_observations owner JOIN literatures actual ON actual.literature_id=owner.literature_id" +
  " WHERE owner.observation_id=" +
  c +
  ".metadata_observation_id AND actual.literature_id=" +
  c +
  ".actual_literature_id AND actual.meta_literature_id=" +
  c +
  ".meta_literature_id))";
export const invalidCitationCause = (
  c: string,
  kind = kindSql(c + ".discovery_run_id"),
) =>
  "(" +
  kind +
  " IS NOT 'citation' OR " +
  c +
  ".actual_literature_id NOT IN (" +
  c +
  ".source_literature_id," +
  c +
  ".target_literature_id)" +
  " OR NOT " +
  hasResult(c) +
  " OR NOT EXISTS(SELECT 1 FROM literatures l WHERE l.literature_id=" +
  c +
  ".source_literature_id)" +
  " OR NOT EXISTS(SELECT 1 FROM literatures l WHERE l.literature_id=" +
  c +
  ".target_literature_id)" +
  " OR NOT EXISTS(SELECT 1 FROM literatures l WHERE l.literature_id=" +
  c +
  ".actual_literature_id AND l.meta_literature_id=" +
  c +
  ".meta_literature_id))";
export const invalidDiscoveryResult = (
  r: string,
  kind = kindSql(r + ".discovery_run_id"),
) =>
  "(CASE " +
  kind +
  " WHEN 'topic' THEN NOT EXISTS(SELECT 1 FROM " +
  topic +
  " cause WHERE cause.discovery_run_id=" +
  r +
  ".discovery_run_id AND cause.meta_literature_id=" +
  r +
  ".meta_literature_id)" +
  " WHEN 'citation' THEN NOT EXISTS(SELECT 1 FROM " +
  citation +
  " cause WHERE cause.discovery_run_id=" +
  r +
  ".discovery_run_id AND cause.meta_literature_id=" +
  r +
  ".meta_literature_id)" +
  " ELSE 1 END)";

export function refreshDiscoveryIntegrity(keys: string) {
  const condition = (table: string, invalid: string) =>
    "EXISTS(SELECT 1 FROM " +
    table +
    " c WHERE c.discovery_run_id=k.discovery_run_id AND c.meta_literature_id=k.meta_literature_id AND " +
    invalid +
    ")";
  return [
    `DELETE FROM library_discovery_invalid WHERE (discovery_run_id,meta_literature_id) IN (
       SELECT discovery_run_id,meta_literature_id FROM (${keys}))`,
    "INSERT INTO library_discovery_invalid SELECT k.discovery_run_id,k.meta_literature_id FROM (" +
      keys +
      ") k WHERE " +
      [
        condition(topic, invalidTopicCause("c")),
        condition(citation, invalidCitationCause("c")),
        condition(results, invalidDiscoveryResult("c")),
      ].join(" OR ") +
      " ON CONFLICT DO NOTHING",
  ];
}

const sides = ["INSERT", "UPDATE", "DELETE"] as const;
type Event = (typeof sides)[number];
type Side = "new" | "old";
const trigger = (
  name: string,
  action: string,
  body: readonly string[],
  timing = "AFTER",
  when = "",
) =>
  "CREATE TRIGGER library_paging_" +
  name +
  " " +
  timing +
  " " +
  action +
  when +
  " BEGIN " +
  body.join("; ") +
  "; END";
const changes = (
  table: string,
  select: (side: Side) => string,
  body: (keys: string) => string[],
  {
    update,
    events = sides,
    when,
  }: {
    update?: string;
    events?: readonly Event[];
    when?: (event: Event, keys: string) => string;
  } = {},
) =>
  events.map((event) => {
    const keys =
      event === "INSERT"
        ? select("new")
        : event === "DELETE"
          ? select("old")
          : select("old") + " UNION " + select("new");
    const predicate = when?.(event, keys);
    return trigger(
      table + "_" + event.toLowerCase(),
      (event === "UPDATE" && update ? "UPDATE OF " + update : event) +
        " ON " +
        table,
      body(keys),
      "AFTER",
      predicate ? ` WHEN ${predicate}` : "",
    );
  });

const updateMemberTime = (side: Side, time: string, condition = "") =>
  `UPDATE library_ordered_members SET intake_at=${time}
   WHERE literature_id=${side}.literature_id AND intake_at IS NOT ${time}${condition}`;

const lit = (side: Side) =>
  "SELECT " + side + ".literature_id AS literature_id";
const keysForIntake = (owners: string) =>
  "SELECT batch_id AS scope_id,literature_id FROM intake_batch_members WHERE literature_id IN (" +
  owners +
  ")";
const findDiscovery = (ids: string, fields: string, distinct = true) =>
  [
    "SELECT " +
      fields +
      " FROM " +
      topic +
      " WHERE actual_literature_id IN (" +
      ids +
      ")",
    "SELECT " +
      fields +
      " FROM " +
      citation +
      " WHERE source_literature_id IN (" +
      ids +
      ")",
    "SELECT " +
      fields +
      " FROM " +
      citation +
      " WHERE target_literature_id IN (" +
      ids +
      ")",
  ].join(distinct ? " UNION " : " UNION ALL ");
const discoveryMemberFields =
  "discovery_run_id AS scope_id,actual_literature_id AS literature_id";
const discoveryGroupFields = "discovery_run_id,meta_literature_id";
const subtreeOwners = (side: Side) =>
  "SELECT DISTINCT m.literature_id FROM (WITH RECURSIVE subtree(id) AS (SELECT " +
  side +
  ".folder_id UNION SELECT f.folder_id FROM subtree s JOIN folders f ON f.parent_id=s.id) SELECT id FROM subtree) s JOIN folder_members m ON m.folder_id=s.id";
const withdrawalFolders = (side: Side) =>
  "SELECT literature_id FROM folder_members WHERE " +
  side +
  ".object_kind='folder' AND folder_id=" +
  side +
  ".object_id UNION " +
  "SELECT CASE WHEN json_valid(" +
  side +
  ".object_id) THEN json_extract(" +
  side +
  ".object_id,'$[1]') END WHERE " +
  side +
  ".object_kind='folder-member' UNION " +
  "SELECT " +
  side +
  ".object_id WHERE " +
  side +
  ".object_kind='literature'";
const withdrawalLiterature = (side: Side) =>
  "SELECT " + side + ".object_id WHERE " + side + ".object_kind='literature'";

/** The cause unique keys can implicitly replace a row even with recursive_triggers disabled. */
function causeTriggers(table: typeof topic | typeof citation) {
  const key =
    table === topic
      ? "c.metadata_observation_id=new.metadata_observation_id"
      : "c.source_literature_id=new.source_literature_id AND c.target_literature_id=new.target_literature_id AND c.depth=new.depth";
  const replacement = `FROM ${table} c WHERE c.discovery_run_id=new.discovery_run_id AND ${key}
    AND (c.meta_literature_id<>new.meta_literature_id OR c.actual_literature_id<>new.actual_literature_id)`;
  const stash = `INSERT INTO library_discovery_replaced
    SELECT '${table}',c.discovery_run_id,c.meta_literature_id,c.actual_literature_id ${replacement} ON CONFLICT DO NOTHING`;
  const staged =
    " FROM library_discovery_replaced WHERE source='" + table + "'";
  const clear = "DELETE" + staged;
  const visible = [
    alive("new.actual_literature_id"),
    ...(table === citation
      ? [alive("new.source_literature_id"), alive("new.target_literature_id")]
      : []),
  ].join(" AND ");
  return [
    ...["INSERT", "UPDATE"].map((event) =>
      trigger(
        table + "_replace_" + event.toLowerCase(),
        event + " ON " + table,
        [clear, stash],
        "BEFORE",
        ` WHEN EXISTS(SELECT 1${staged}) OR EXISTS(SELECT 1 ${replacement})`,
      ),
    ),
    ...sides.map((event) => {
      const select = (row: Side, member: boolean) =>
        member
          ? "SELECT " +
            row +
            ".discovery_run_id AS scope_id," +
            row +
            ".actual_literature_id AS literature_id"
          : "SELECT " +
            row +
            ".discovery_run_id AS discovery_run_id," +
            row +
            ".meta_literature_id AS meta_literature_id";
      const keys = (member: boolean) =>
        [
          ...(event !== "INSERT" ? [select("old", member)] : []),
          ...(event !== "DELETE" ? [select("new", member)] : []),
          "SELECT " +
            (member ? discoveryMemberFields : discoveryGroupFields) +
            staged,
        ].join(" UNION ");
      return trigger(
        table + "_" + event.toLowerCase(),
        event + " ON " + table,
        [
          ...(event === "INSERT"
            ? [
                insertVisibleMember(
                  "discovery",
                  "new.discovery_run_id",
                  "new.actual_literature_id",
                  visible,
                ),
                ...refreshDiscoveryMembers(
                  "SELECT " + discoveryMemberFields + staged,
                ),
              ]
            : refreshDiscoveryMembers(keys(true))),
          ...refreshDiscoveryIntegrity(keys(false)),
          clear,
        ],
      );
    }),
  ];
}

export const libraryPagingSchema = (historicalTime: string) =>
  [
    "CREATE TABLE library_collection_times(literature_id TEXT PRIMARY KEY,collected_at TEXT,FOREIGN KEY(literature_id) REFERENCES literatures(literature_id) ON DELETE CASCADE ON UPDATE CASCADE) STRICT",
    "CREATE INDEX library_collection_time_order ON library_collection_times(collected_at DESC,literature_id)",
    "CREATE TABLE library_ordered_members(kind TEXT NOT NULL,scope_id TEXT NOT NULL,literature_id TEXT NOT NULL,intake_at TEXT,PRIMARY KEY(kind,scope_id,literature_id)) STRICT, WITHOUT ROWID",
    "CREATE INDEX library_ordered_members_order ON library_ordered_members(kind,scope_id,intake_at DESC,literature_id)",
    "CREATE INDEX library_ordered_members_literature ON library_ordered_members(literature_id,kind)",
    "CREATE INDEX library_paging_folders_parent ON folders(parent_id,folder_id)",
    "CREATE INDEX library_paging_topic_owner ON topic_discovery_causes(discovery_run_id,actual_literature_id)",
    "CREATE INDEX library_paging_citation_owner ON citation_discovery_causes(discovery_run_id,actual_literature_id)",
    "CREATE TABLE library_discovery_invalid(discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,PRIMARY KEY(discovery_run_id,meta_literature_id)) STRICT, WITHOUT ROWID",
    "CREATE TABLE library_discovery_replaced(source TEXT NOT NULL,discovery_run_id TEXT NOT NULL,meta_literature_id TEXT NOT NULL,actual_literature_id TEXT NOT NULL,PRIMARY KEY(source,discovery_run_id,meta_literature_id,actual_literature_id)) STRICT, WITHOUT ROWID",
    "CREATE TABLE library_paging_progress(singleton INTEGER PRIMARY KEY CHECK(singleton=1),stage INTEGER NOT NULL,after_rowid INTEGER) STRICT",
    "CREATE INDEX library_paging_intake_item_owner ON intake_items(literature_id) WHERE origin='page' AND literature_id IS NOT NULL",
    trigger("collection_insert", "INSERT ON library_collected", [
      `INSERT INTO library_collection_times SELECT new.literature_id,
      coalesce(CASE WHEN NOT EXISTS(SELECT 1 FROM library_state_progress WHERE collection_ready=1)
        THEN ${historicalTime} END,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      WHERE NOT EXISTS(SELECT 1 FROM library_collection_times WHERE literature_id=new.literature_id)
      ON CONFLICT DO NOTHING`,
    ]),
    ...changes("folder_members", lit, refreshFolderMembers, {
      update: "folder_id,literature_id",
    }),
    ...changes("folders", subtreeOwners, refreshFolderMembers, {
      update: "folder_id,parent_id",
    }),
    trigger("intake_batch_members_insert", "INSERT ON intake_batch_members", [
      insertVisibleMember("intake", "new.batch_id", "new.literature_id"),
    ]),
    ...changes(
      "intake_batch_members",
      (s) =>
        `SELECT ${s}.batch_id AS scope_id,${s}.literature_id AS literature_id`,
      refreshIntakeMembers,
      { update: "batch_id,literature_id", events: ["UPDATE", "DELETE"] },
    ),
    trigger("literature_intake_insert", "INSERT ON literature_intake", [
      updateMemberTime("new", "new.intake_at"),
    ]),
    trigger(
      "literature_intake_update",
      "UPDATE OF literature_id,intake_at ON literature_intake",
      [
        updateMemberTime(
          "old",
          "NULL",
          " AND old.literature_id IS NOT new.literature_id",
        ),
        updateMemberTime("new", "new.intake_at"),
      ],
      "AFTER",
      " WHEN old.literature_id IS NOT new.literature_id OR old.intake_at IS NOT new.intake_at",
    ),
    trigger("literature_intake_delete", "DELETE ON literature_intake", [
      updateMemberTime("old", "NULL"),
    ]),
    ...sides.map((event) => {
      const select = (query: (side: Side) => string) =>
        event === "INSERT"
          ? query("new")
          : event === "DELETE"
            ? query("old")
            : query("old") + " UNION " + query("new");
      const owners = select(withdrawalLiterature);
      return trigger(
        "visibility_" + event.toLowerCase(),
        (event === "UPDATE" ? "UPDATE OF object_kind,object_id" : event) +
          " ON intake_withdrawn_objects",
        [
          ...refreshFolderMembers(
            "SELECT DISTINCT literature_id FROM (" +
              select(withdrawalFolders) +
              ") WHERE literature_id IS NOT NULL",
          ),
          ...refreshIntakeMembers(keysForIntake(owners)),
          ...refreshDiscoveryMembers(
            findDiscovery(owners, discoveryMemberFields),
          ),
        ],
      );
    }),
    ...causeTriggers(topic),
    ...causeTriggers(citation),
    ...changes(
      results,
      (s) =>
        "SELECT " +
        s +
        ".discovery_run_id AS discovery_run_id," +
        s +
        ".meta_literature_id AS meta_literature_id",
      refreshDiscoveryIntegrity,
      { update: "discovery_run_id,meta_literature_id" },
    ),
    ...changes(
      "discovery_runs",
      (s) =>
        [topic, citation, results]
          .map(
            (t) =>
              "SELECT discovery_run_id,meta_literature_id FROM " +
              t +
              " WHERE discovery_run_id=" +
              s +
              ".discovery_run_id",
          )
          .join(" UNION "),
      refreshDiscoveryIntegrity,
      { update: "discovery_run_id,kind" },
    ),
    ...changes(
      "literatures",
      (s) => findDiscovery(lit(s), discoveryGroupFields),
      refreshDiscoveryIntegrity,
      {
        update: "literature_id,meta_literature_id",
        when: (event) =>
          event === "UPDATE"
            ? "old.literature_id IS NOT new.literature_id OR old.meta_literature_id IS NOT new.meta_literature_id"
            : `EXISTS(${findDiscovery(lit(event === "INSERT" ? "new" : "old"), "1", false)})`,
      },
    ),
    ...changes(
      "literature_metadata_observations",
      (s) =>
        "SELECT discovery_run_id,meta_literature_id FROM " +
        topic +
        " WHERE metadata_observation_id=" +
        s +
        ".observation_id",
      refreshDiscoveryIntegrity,
      {
        update: "observation_id,literature_id",
        when: (_event, keys) => `EXISTS(${keys})`,
      },
    ),
  ] as const;
