export type Mode = "none" | "all" | "locate" | "one";

// A Map, not an object literal. Names inherited from Object.prototype (constructor, toString, __proto__)
// are not keys of a Map, so modeOf gives them "one".
export const OPERATION_MODES: ReadonlyMap<string, Mode> = new Map<string, Mode>([
  ["search_docs", "none"],
  ["list_organizations", "all"],
  ["list_projects", "all"],
  ["create_project", "one"],
  ["pause_project", "one"],
  ["restore_project", "one"],
  ["create_branch", "one"],
  ["delete_branch", "one"],
  ["merge_branch", "one"],
  ["reset_branch", "one"],
  ["rebase_branch", "one"],
  ["apply_migration", "one"],
  ["deploy_edge_function", "one"],
  ["update_storage_config", "one"],
  ["confirm_cost", "one"],
  ["get_cost", "one"],
  ["execute_sql", "one"],
  ["get_organization", "locate"],
  ["get_project", "locate"],
  ["list_branches", "locate"],
  ["list_tables", "locate"],
  ["list_extensions", "locate"],
  ["list_migrations", "locate"],
  ["query_logs", "locate"],
  ["get_advisors", "locate"],
  ["get_project_url", "locate"],
  ["get_publishable_keys", "locate"],
  ["generate_typescript_types", "locate"],
  ["list_edge_functions", "locate"],
  ["get_edge_function", "locate"],
  ["list_notebooks", "locate"],
  ["get_notebook", "locate"],
  ["list_storage_buckets", "locate"],
  ["get_storage_config", "locate"],
]);

// An operation the table does not classify is "one", so a change never goes to several accounts.
export const modeOf = (tool: string): Mode => OPERATION_MODES.get(tool) ?? "one";

// The read-only query tool, which the owner chose to add. It is not listed until a live check shows that the API
// enforces read-only.
export const READONLY_QUERY_TOOL = "execute_sql_readonly";
export const READONLY_QUERY_EXPOSED = false;
