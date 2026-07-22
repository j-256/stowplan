import type { SyncConflict } from "./types";

export class DomainError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "DomainError";
        this.code = code;
    }
}

export class ConflictError extends DomainError {
    readonly conflicts: SyncConflict[];

    constructor(message: string, conflicts: SyncConflict[]) {
        super("CONFLICT", message);
        this.name = "ConflictError";
        this.conflicts = conflicts;
    }
}
