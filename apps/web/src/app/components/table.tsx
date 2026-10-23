import { useMemo, type ReactNode } from "react";
import {
  createSortedRowModel,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Button } from "./actions.js";
import { Checkbox } from "./fields.js";
import { Icon } from "./icons.js";
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns,
});
export interface DataColumn<T> {
  id: string;
  header: string;
  value: (row: T) => string | number | boolean | null;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  /** Right-aligned tabular figures for counts and measurements. */
  numeric?: boolean;
}
export interface DataTableProps<T> {
  label: string;
  rows: T[];
  columns: readonly DataColumn<T>[];
  getRowId: (row: T) => string;
  selected?: ReadonlySet<string>;
  highlighted?: ReadonlySet<string>;
  onSelectionChange?: (value: Set<string>) => void;
  empty?: string;
}
/** Sorting applies only to the supplied page; range queries remain the data owner's responsibility. */
export function DataTable<T extends object>({
  label,
  rows,
  columns: definitions,
  getRowId,
  selected,
  highlighted,
  onSelectionChange,
  empty = "当前范围没有结果。",
}: DataTableProps<T>) {
  const columns = useMemo<ColumnDef<typeof features, T>[]>(
    () =>
      definitions.map((column) => ({
        id: column.id,
        header: column.header,
        accessorFn: column.value,
        enableSorting: column.sortable ?? true,
        cell: (context) =>
          column.render
            ? column.render(context.row.original)
            : String(context.getValue() ?? "未提供"),
      })),
    [definitions],
  );
  const table = useTable({ features, data: rows, columns, getRowId });
  const numeric = new Set(
    definitions.filter((column) => column.numeric).map((column) => column.id),
  );
  const select = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange?.(next);
  };
  return (
    <div className="ui-table-wrap">
      <table className="ui-data-table" aria-label={label}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {onSelectionChange ? (
                <th scope="col">
                  <Checkbox
                    aria-label="选择当前结果页"
                    isSelected={
                      rows.length > 0 &&
                      rows.every((row) => selected?.has(getRowId(row)))
                    }
                    onChange={(checked) => {
                      const next = new Set(selected);
                      for (const row of rows) {
                        if (checked) next.add(getRowId(row));
                        else next.delete(getRowId(row));
                      }
                      onSelectionChange(next);
                    }}
                  />
                </th>
              ) : null}
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  data-numeric={numeric.has(header.column.id) || undefined}
                  aria-sort={
                    header.column.getIsSorted() === "asc"
                      ? "ascending"
                      : header.column.getIsSorted() === "desc"
                        ? "descending"
                        : "none"
                  }
                >
                  {header.column.getCanSort() ? (
                    <Button
                      variant="text"
                      size="compact"
                      onPress={() => header.column.toggleSorting()}
                    >
                      <table.FlexRender header={header} />
                      {header.column.getIsSorted() ? (
                        <Icon
                          name="chevron"
                          className={
                            header.column.getIsSorted() === "asc"
                              ? "ui-sort-ascending"
                              : ""
                          }
                        />
                      ) : null}
                    </Button>
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              data-highlighted={highlighted?.has(row.id) ?? false}
              data-selected={selected?.has(row.id) ?? false}
            >
              {onSelectionChange ? (
                <td>
                  <Checkbox
                    aria-label={`选择第 ${row.index + 1} 条结果`}
                    isSelected={selected?.has(row.id) ?? false}
                    onChange={(checked) => select(row.id, checked)}
                  />
                </td>
              ) : null}
              {row.getAllCells().map((cell) => (
                <td
                  key={cell.id}
                  data-numeric={numeric.has(cell.column.id) || undefined}
                >
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (onSelectionChange ? 1 : 0)}>
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
