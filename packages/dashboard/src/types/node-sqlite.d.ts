/** node:sqlite — new in Node 22, and its types are not in @types/node 20 yet. */
declare module 'node:sqlite' {
  export interface StatementSync {
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
