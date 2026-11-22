import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import type { FolderNode, LibraryQuery } from "@sciretriever/contracts";
import {
  Button,
  ConfirmDialog,
  Dialog,
  Icon,
  IconButton,
  Menu,
  Select,
  TextField,
  useToast,
} from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { navigate, useUrlState } from "../../data/url.js";
import { preferences } from "../../data/preferences.js";
import { emptyQuery, readLibraryCounts } from "../../data/library.js";
import {
  exportFolders,
  listFolders,
  manageFolder,
  previewFolderDeletion,
} from "../../data/folders.js";
import { download } from "../../data/download.js";
import { useShell } from "../../shell/context.js";
import { errorMessage } from "../../strings.js";
import { useRecentBatches } from "../../data/intake-batches.js";

/** Drag payloads between library rows and the folder tree. */
export const LITERATURE_DRAG = "application/x-sciretriever-literature";
const FOLDER_DRAG = "application/x-sciretriever-folder";
const EXPANDED_KEY = "sciretriever:folders:expanded:v1";

export function useFolders() {
  const api = useApi();
  return useQuery({
    queryKey: ["folders"],
    queryFn: ({ signal }) => listFolders(api, signal),
    enabled: api.kind === "workspace" && api.workspace.readiness === "ready",
  });
}
function children(items: readonly FolderNode[]) {
  const map = new Map<string | null, FolderNode[]>();
  for (const item of items) {
    const list = map.get(item.parent_id) ?? [];
    list.push(item);
    map.set(item.parent_id, list);
  }
  for (const list of map.values())
    list.sort(
      (a, b) =>
        a.position - b.position || a.folder_id.localeCompare(b.folder_id),
    );
  return map;
}
/** "Parent / Child" labels in tree order, for pickers and headings. */
export function folderPaths(items: readonly FolderNode[]) {
  const tree = children(items),
    paths: { id: string; label: string }[] = [];
  const visit = (parent: string | null, prefix: string) => {
    for (const node of tree.get(parent) ?? []) {
      const label = prefix ? `${prefix} / ${node.name}` : node.name;
      paths.push({ id: node.folder_id, label });
      visit(node.folder_id, label);
    }
  };
  visit(null, "");
  return paths;
}
/** Folder scope replaces the filters: a folder shows its own papers. */
export function scopeQuery(
  scope: Pick<LibraryQuery, "folder" | "recently_opened">,
): LibraryQuery {
  // Absent keys keep plain library URLs and snapshot definitions unchanged.
  return {
    ...emptyQuery(),
    ...(scope.folder ? { folder: scope.folder } : {}),
    ...(scope.recently_opened ? { recently_opened: true } : {}),
  };
}
/** The same filters without a folder or "recently read" scope. */
export function withoutScope(query: LibraryQuery): LibraryQuery {
  const rest: { -readonly [K in keyof LibraryQuery]: LibraryQuery[K] } = {
    ...query,
  };
  delete rest.folder;
  delete rest.recently_opened;
  return rest;
}
function openScope(scope: Pick<LibraryQuery, "folder" | "recently_opened">) {
  // Each working set opens in its own default order (page specs “文献库”).
  navigate(
    {
      view: "lib",
      literature: null,
      query: JSON.stringify(scopeQuery(scope)),
      sort: null,
    },
    { clearSource: true },
  );
}
/** The papers read in the last 30 days, the last opened first. */
export function openRecent() {
  openScope({ recently_opened: true });
}
/** The library limited to one intake batch, newest intake first. */
export function openBatch(id: string) {
  navigate(
    {
      view: "lib",
      literature: null,
      query: JSON.stringify({ ...emptyQuery(), intake_batch_ids: [id] }),
      sort: null,
    },
    { clearSource: true },
  );
}
/** The library scoped to one folder, as clicking it in the tree does. */
export function openFolder(id: string) {
  openScope({ folder: { id, include_descendants: true } });
}
function dragKind(event: DragEvent) {
  const types = event.dataTransfer.types;
  return types.includes(LITERATURE_DRAG)
    ? "literature"
    : types.includes(FOLDER_DRAG)
      ? "folder"
      : null;
}

/**
 * The newest intake batches under “入库” in the sidebar (page specs “整体信息架构”):
 * a batch opens the library limited to it.
 */
export function IntakeBatches({ onNavigate }: { onNavigate: () => void }) {
  const route = useUrlState();
  const batches = useRecentBatches();
  if (!batches.data?.items.length) return null;
  return (
    <div
      className="folder-navigation folder-batches"
      role="group"
      aria-label="最近入库"
    >
      {batches.data.items.map((batch) => {
        const current =
          route.section === "lib" &&
          !route.literature &&
          route.query.intake_batch_ids.length === 1 &&
          route.query.intake_batch_ids[0] === batch.batch_id;
        return (
          <Button
            key={batch.batch_id}
            variant="text"
            className="folder-open folder-batch"
            aria-current={current ? "page" : false}
            aria-label={`${batch.label}，${batch.counts.hits} 篇`}
            onPress={() => {
              openBatch(batch.batch_id);
              onNavigate();
            }}
          >
            <span className="folder-name" title={batch.label}>
              {batch.label}
            </span>
            <span className="navigation-count">
              {batch.counts.hits.toLocaleString()}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/** The library's folder tree in the sidebar: recent papers, folders, management. */
/** At most this many open papers are listed; the rest are counted. */
const READING_SHOWN = 5;
/**
 * “正在读” (plan 25 block 30): the papers open in the reader, so they can be
 * gone back to from any page. Each title on one line; past five, “另外 n
 * 篇” opens the next one in the reader. Absent while none is open.
 */
function ReadingNow({ onNavigate }: { onNavigate: () => void }) {
  const shell = useShell(),
    route = useUrlState();
  const open = shell.tabs.list;
  if (!open.length) return null;
  const shown = open.slice(0, READING_SHOWN),
    more = open.length - shown.length;
  const go = (id: string) => {
    shell.tabs.show(id);
    onNavigate();
  };
  return (
    <div className="reading-now" role="group" aria-label="正在读">
      <div className="folder-heading">
        <span className="navigation-group-name">正在读</span>
      </div>
      {shown.map((tab) => (
        <Button
          key={tab.id}
          variant="text"
          className="folder-open reading-now-paper"
          aria-current={route.literature === tab.id ? "page" : false}
          icon={<Icon name="file" />}
          onPress={() => go(tab.id)}
        >
          <span className="folder-name" title={tab.title}>
            {tab.title}
          </span>
        </Button>
      ))}
      {more > 0 ? (
        <Button
          variant="text"
          className="folder-open reading-now-more"
          onPress={() => go(open[READING_SHOWN]!.id)}
        >
          另外 {more} 篇
        </Button>
      ) : null}
    </div>
  );
}

export function LibraryFolders({ onNavigate }: { onNavigate: () => void }) {
  const api = useApi(),
    route = useUrlState(),
    shell = useShell(),
    queries = useQueryClient();
  const folders = useFolders();
  const counts = useQuery({
    queryKey: ["library", "counts", emptyQuery()],
    queryFn: ({ signal }) => readLibraryCounts(api, emptyQuery(), signal),
    enabled: api.workspace.readiness === "ready",
    placeholderData: keepPreviousData,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    try {
      const values: unknown = JSON.parse(
        preferences.read(EXPANDED_KEY) ?? "[]",
      );
      return new Set(
        Array.isArray(values)
          ? values.filter((v): v is string => typeof v === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const [editing, setEditing] = useState<{
    parent: string | null;
    folder?: FolderNode;
  } | null>(null);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<FolderNode | null>(null);
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [landed, setLanded] = useState<string | null>(null);
  const toast = useToast();
  // A collapsed folder held under a drag opens, so nested folders are reachable.
  const opening = useRef<{
    id: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const stopOpening = () => {
    if (opening.current) clearTimeout(opening.current.timer);
    opening.current = null;
  };
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(null), 900);
    return () => clearTimeout(timer);
  }, [landed]);
  useEffect(() => stopOpening, []);
  const manage = useMutation({
    mutationFn: (command: unknown) => manageFolder(api, command),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ["folders"] });
      void queries.invalidateQueries({ queryKey: ["library"] });
    },
    onError: (error) => shell.notify(errorMessage(error)),
  });
  const impact = useQuery({
    queryKey: ["folders", "delete-preview", removing?.folder_id],
    queryFn: ({ signal }) =>
      previewFolderDeletion(api, removing!.folder_id, signal),
    enabled: removing !== null,
  });
  const items = folders.data?.items ?? [];
  const tree = children(items);
  const current = route.section === "lib" ? route.query.folder?.id : undefined;
  const toggle = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(id);
    else next.delete(id);
    setExpanded(next);
    preferences.write(EXPANDED_KEY, JSON.stringify([...next]));
  };
  const open = (node: FolderNode) => {
    openFolder(node.folder_id);
    onNavigate();
  };
  const move = (id: string, parent: string | null, position: number) =>
    manage.mutate({
      operation: "move",
      request: { folder_id: id, parent_id: parent, position },
    });
  const dragOver = (id: string | null) => (event: DragEvent) => {
    const kind = dragKind(event);
    if (!kind || (kind === "literature" && id === null)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = kind === "literature" ? "copy" : "move";
    setTarget(id);
    if (
      id &&
      opening.current?.id !== id &&
      (tree.get(id)?.length ?? 0) > 0 &&
      !expanded.has(id)
    ) {
      stopOpening();
      opening.current = { id, timer: setTimeout(() => toggle(id, true), 650) };
    }
  };
  const leave = (event: DragEvent) => {
    // Moving between a row's own children is not leaving it.
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setTarget(undefined);
    stopOpening();
  };
  const drop = (id: string | null) => (event: DragEvent) => {
    event.preventDefault();
    setTarget(undefined);
    stopOpening();
    const papers = event.dataTransfer.getData(LITERATURE_DRAG),
      folder = event.dataTransfer.getData(FOLDER_DRAG);
    if (papers && id) {
      const ids = (JSON.parse(papers) as unknown[]).filter(
        (v): v is string => typeof v === "string",
      );
      const label = items.find((item) => item.folder_id === id)?.name ?? "";
      if (ids.length)
        manage.mutate(
          {
            operation: "add",
            request: { folder_id: id, literature_ids: ids.slice(0, 1000) },
          },
          {
            onSuccess: (result) => {
              const added = "changed_ids" in result ? result.changed_ids : [];
              setLanded(id);
              if (!added.length) {
                toast(`这些文献已在「${label}」中`);
                return;
              }
              toast({
                message: `已加入「${label}」：新增 ${added.length.toLocaleString()} 篇`,
                action: {
                  label: "撤销",
                  onPress: () =>
                    manage.mutate(
                      {
                        operation: "remove",
                        request: { folder_id: id, literature_ids: added },
                      },
                      {
                        onSuccess: () =>
                          toast(
                            `已撤销，${added.length.toLocaleString()} 篇移出「${label}」`,
                          ),
                      },
                    ),
                },
              });
            },
          },
        );
    } else if (folder && folder !== id) {
      move(folder, id, tree.get(id)?.length ?? 0);
      if (id) toggle(id, true);
    }
  };
  const level = (parent: string | null, depth: number) => (
    <ul className="folder-tree">
      {(tree.get(parent) ?? []).map((node, index, siblings) => {
        const nested = (tree.get(node.folder_id) ?? []).length > 0,
          isOpen = expanded.has(node.folder_id);
        return (
          <li key={node.folder_id}>
            <div
              className="folder-row"
              style={{ paddingInlineStart: `${depth * 14}px` }}
              data-drop={target === node.folder_id || undefined}
              data-landed={landed === node.folder_id || undefined}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(FOLDER_DRAG, node.folder_id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={dragOver(node.folder_id)}
              onDragLeave={leave}
              onDrop={drop(node.folder_id)}
            >
              {nested ? (
                <IconButton
                  className="folder-toggle"
                  size="inline"
                  variant="text"
                  aria-label={`${isOpen ? "收起" : "展开"} ${node.name}`}
                  aria-expanded={isOpen}
                  data-open={isOpen || undefined}
                  icon={<Icon name="chevron" />}
                  onPress={() => toggle(node.folder_id, !isOpen)}
                />
              ) : (
                <span className="folder-toggle" aria-hidden="true" />
              )}
              <Button
                variant="text"
                className="folder-open"
                aria-current={current === node.folder_id ? "page" : false}
                icon={<Icon name="folder" />}
                onPress={() => open(node)}
              >
                <span className="folder-name">{node.name}</span>
                <span className="navigation-count">
                  {node.total_count.toLocaleString()}
                </span>
              </Button>
              <Menu
                iconOnly
                className="folder-menu"
                label={`文件夹操作：${node.name}`}
                items={[
                  {
                    id: "create",
                    label: "新建子文件夹…",
                    onAction: () => {
                      setName("");
                      setEditing({ parent: node.folder_id });
                    },
                  },
                  {
                    id: "rename",
                    label: "重命名…",
                    onAction: () => {
                      setName(node.name);
                      setEditing({ parent: node.parent_id, folder: node });
                    },
                  },
                  {
                    id: "up",
                    label: "上移",
                    disabled: index === 0,
                    onAction: () =>
                      move(node.folder_id, node.parent_id, index - 1),
                  },
                  {
                    id: "down",
                    label: "下移",
                    disabled: index === siblings.length - 1,
                    onAction: () =>
                      move(node.folder_id, node.parent_id, index + 1),
                  },
                  {
                    id: "top",
                    label: "移到顶层",
                    disabled: node.parent_id === null,
                    onAction: () =>
                      move(node.folder_id, null, tree.get(null)?.length ?? 0),
                  },
                  {
                    id: "delete",
                    label: "删除…",
                    onAction: () => setRemoving(node),
                  },
                ]}
              />
            </div>
            {nested && isOpen ? level(node.folder_id, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );
  // User organization 9.5: the whole tree and its members, written by the
  // service; a failure says so and nothing is saved.
  const exporting = useMutation({
    mutationFn: () => exportFolders(api),
    onSuccess: (blob) => download(blob, "sciretriever-folders.json"),
    onError: (error) => shell.notify(`没有导出分组。${errorMessage(error)}`),
  });
  const recent = route.section === "lib" && route.query.recently_opened;
  return (
    <div
      className="folder-navigation"
      role="group"
      aria-label="文献文件夹"
      data-drop={target === null || undefined}
      onDragOver={(event) => {
        // Dropping a folder on empty tree space moves it to the top level.
        if (event.target === event.currentTarget) dragOver(null)(event);
      }}
      onDrop={(event) => {
        if (event.target === event.currentTarget) drop(null)(event);
      }}
    >
      <ReadingNow onNavigate={onNavigate} />
      <Button
        variant="text"
        className="folder-open folder-recent"
        aria-current={recent ? "page" : false}
        icon={<Icon name="clock" />}
        onPress={() => {
          openRecent();
          onNavigate();
        }}
      >
        <span className="folder-name">最近阅读</span>
        <span className="navigation-count">
          {counts.data?.recently_opened.toLocaleString() ?? ""}
        </span>
      </Button>
      <div className="folder-heading">
        <span className="navigation-group-name">文件夹</span>
        <Menu
          iconOnly
          className="folder-menu"
          label="文件夹一组的操作"
          items={[
            {
              id: "export",
              label: exporting.isPending ? "正在导出分组…" : "导出分组",
              disabled: exporting.isPending,
              onAction: () => exporting.mutate(),
            },
          ]}
        />
      </div>
      {folders.isError ? (
        <Button variant="text" onPress={() => void folders.refetch()}>
          文件夹读取失败，重试
        </Button>
      ) : (
        level(null, 0)
      )}
      <Button
        variant="text"
        className="folder-create"
        icon={<Icon name="plus" />}
        onPress={() => {
          setName("");
          setEditing({ parent: null });
        }}
      >
        新建文件夹
      </Button>
      <Dialog
        title={editing?.folder ? "重命名文件夹" : "新建文件夹"}
        isOpen={editing !== null}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
        footer={
          <Button
            variant="primary"
            isPending={manage.isPending}
            disabledReason={name.trim() ? undefined : "请输入文件夹名称。"}
            onPress={() =>
              manage.mutate(
                editing?.folder
                  ? {
                      operation: "rename",
                      request: {
                        folder_id: editing.folder.folder_id,
                        name: name.trim(),
                      },
                    }
                  : {
                      operation: "create",
                      request: {
                        parent_id: editing?.parent ?? null,
                        name: name.trim(),
                        position: null,
                      },
                    },
                {
                  onSuccess: () => {
                    if (editing?.parent) toggle(editing.parent, true);
                    setEditing(null);
                  },
                },
              )
            }
          >
            {editing?.folder ? "保存" : "创建"}
          </Button>
        }
      >
        {editing?.parent && !editing.folder ? (
          <p>
            放在「
            {items.find((item) => item.folder_id === editing.parent)?.name}
            」下。
          </p>
        ) : null}
        <TextField label="文件夹名称" value={name} onChange={setName} />
      </Dialog>
      <ConfirmDialog
        title="删除文件夹"
        isOpen={removing !== null}
        onOpenChange={(value) => {
          if (!value) setRemoving(null);
        }}
        confirmLabel="删除文件夹"
        isPending={manage.isPending}
        description={
          impact.isPending ? (
            <p role="status">正在统计受影响的文件夹与文献…</p>
          ) : impact.isError ? (
            <p>{errorMessage(impact.error)}</p>
          ) : (
            <p>
              将删除「{removing?.name}」
              {impact.data!.descendant_count
                ? `及其 ${impact.data!.descendant_count} 个子文件夹`
                : ""}
              。其中的 {impact.data!.literature_count.toLocaleString()}{" "}
              篇文献只会移出这些文件夹，文献本身不会删除。
            </p>
          )
        }
        onConfirm={() => {
          const node = removing!;
          manage.mutate(
            { operation: "delete", request: { folder_id: node.folder_id } },
            {
              onSuccess: () => {
                setRemoving(null);
                // Leave a folder view that no longer exists.
                const gone = (id: string): boolean =>
                  id === current ||
                  (tree.get(id) ?? []).some((child) => gone(child.folder_id));
                if (current && gone(node.folder_id)) openScope({});
              },
            },
          );
        }}
      />
    </div>
  );
}

/** Pick or create a folder, then add the given papers to it. */
export function AddToFolderDialog({
  ids,
  onClose,
}: {
  ids: readonly string[];
  onClose: () => void;
}) {
  const api = useApi(),
    shell = useShell(),
    queries = useQueryClient();
  const folders = useFolders();
  const paths = folderPaths(folders.data?.items ?? []);
  const [chosen, setChosen] = useState("");
  const [created, setCreated] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      let id = chosen;
      if (created.trim()) {
        const node = await manageFolder(api, {
          operation: "create",
          request: {
            parent_id: chosen || null,
            name: created.trim(),
            position: null,
          },
        });
        id = "folder_id" in node ? node.folder_id : "";
      }
      const result = await manageFolder(api, {
        operation: "add",
        request: { folder_id: id, literature_ids: ids },
      });
      return {
        name:
          created.trim() ||
          paths.find((path) => path.id === id)?.label ||
          "文件夹",
        changed: "changed" in result ? result.changed : 0,
      };
    },
    onSuccess: ({ name, changed }) => {
      void queries.invalidateQueries({ queryKey: ["folders"] });
      void queries.invalidateQueries({ queryKey: ["library"] });
      shell.notify(`已加入「${name}」：新增 ${changed} 篇`);
      onClose();
    },
  });
  return (
    <Dialog
      title="加入文件夹"
      isOpen
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      footer={
        <Button
          variant="primary"
          isPending={add.isPending}
          disabledReason={
            chosen || created.trim() ? undefined : "请选择或新建一个文件夹。"
          }
          onPress={() => add.mutate()}
        >
          加入
        </Button>
      }
    >
      <p>将已选的 {ids.length.toLocaleString()} 篇文献加入文件夹。</p>
      <Select
        label="文件夹"
        value={chosen}
        onChange={setChosen}
        placeholder={paths.length ? "请选择" : "还没有文件夹"}
        options={paths.map((path) => ({ value: path.id, label: path.label }))}
      />
      <TextField
        label={chosen ? "或在其中新建子文件夹" : "或新建文件夹"}
        value={created}
        onChange={setCreated}
      />
      {add.isError ? (
        <p className="ui-error-text" role="alert">
          {errorMessage(add.error)}
        </p>
      ) : null}
    </Dialog>
  );
}
