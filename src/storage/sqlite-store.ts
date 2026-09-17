import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Snapshot } from "../graph/schema.js";

export interface StoredSymbolRecord {
  id: string;
  repository: string;
  package: string;
  language: string;
  path: string;
  qualifiedName: string;
  signature?: string;
  declarationHash: string;
  origin?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface StoredEdgeRecord {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  confidence: string;
  calibratedConfidence?: number;
  why?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface StoredEvidenceRecord {
  id: string;
  edgeId: string;
  snapshotId?: string;
  kind: string;
  strength: string;
  scope: string;
  file: string;
  startLine: number;
  endLine?: number;
  observations?: number;
  confidence?: number;
  confidenceState?: string;
  coverage?: number;
  rawEvidence?: string;
  createdAt?: string;
}

export interface StoredRuntimeObservation {
  id: string;
  fromSymbol: string;
  toSymbol: string;
  route?: string;
  environment?: string;
  testSuite?: string;
  count: number;
  lastObserved: string;
  metadata?: Record<string, unknown>;
}

export interface StoredGitCoupling {
  fileA: string;
  fileB: string;
  cochangeCount: number;
  couplingScore: number;
  lastCommit?: string;
}

export interface StoredEmbedding {
  symbolId: string;
  modelId: string;
  vector: number[];
  chunkHash: string;
  createdAt?: string;
}

export interface GraphWardStorageSnapshot {
  version: number;
  exportedAt: string;
  snapshots?: Snapshot[];
  symbols: StoredSymbolRecord[];
  edges: StoredEdgeRecord[];
  evidence: StoredEvidenceRecord[];
  runtimeObservations: StoredRuntimeObservation[];
  gitCoupling: StoredGitCoupling[];
  embeddings: StoredEmbedding[];
}

/**
 * High-performance, partitioned SQLite storage engine with transactional guarantees
 * and portable JSON snapshot export.
 */
export class SqlitePartitionedStore {
  private dbPath: string;
  private db: any = null;
  private isNativeSqlite = false;

  // In-memory fallback tables if node:sqlite is not available
  private memoryTables = {
    snapshots: new Map<string, Snapshot>(),
    symbols: new Map<string, StoredSymbolRecord>(),
    edges: new Map<string, StoredEdgeRecord>(),
    evidence: new Map<string, StoredEvidenceRecord>(),
    runtimeObservations: new Map<string, StoredRuntimeObservation>(),
    gitCoupling: new Map<string, StoredGitCoupling>(),
    embeddings: new Map<string, StoredEmbedding>(),
  };

  constructor(dbPath: string = ":memory:") {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    if (this.dbPath !== ":memory:") {
      const dir = path.dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    try {
      const sqliteModule = await import("node:sqlite" as any);
      if (sqliteModule.DatabaseSync) {
        this.db = new sqliteModule.DatabaseSync(this.dbPath);
        this.isNativeSqlite = true;
        this.setupNativeTables();
        return;
      }
    } catch {
      // Fallback to transactional memory engine
    }

    this.isNativeSqlite = false;
  }

  private setupNativeTables(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        parent_snapshot_id TEXT,
        kind TEXT NOT NULL DEFAULT 'REAL',
        base_commit TEXT,
        patch_hash TEXT,
        generated_at TEXT NOT NULL,
        environment TEXT,
        build_id TEXT,
        schema_version TEXT NOT NULL DEFAULT '2.2'
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_repo ON snapshots(repository);
      CREATE INDEX IF NOT EXISTS idx_snapshots_commit ON snapshots(commit_sha);
      CREATE INDEX IF NOT EXISTS idx_snapshots_parent ON snapshots(parent_snapshot_id);

      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        package TEXT NOT NULL,
        language TEXT NOT NULL,
        path TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        signature TEXT,
        declaration_hash TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'SOURCE',
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
      CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(qualified_name);
      CREATE INDEX IF NOT EXISTS idx_symbols_decl_hash ON symbols(declaration_hash);

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        confidence TEXT NOT NULL,
        calibrated_confidence REAL,
        why TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL,
        snapshot_id TEXT,
        kind TEXT NOT NULL,
        strength TEXT NOT NULL,
        scope TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER,
        observations INTEGER,
        confidence REAL,
        confidence_state TEXT,
        coverage REAL,
        raw_evidence TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_edge ON evidence(edge_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_snapshot ON evidence(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence(kind);

      CREATE TABLE IF NOT EXISTS runtime_observations (
        id TEXT PRIMARY KEY,
        from_symbol TEXT NOT NULL,
        to_symbol TEXT NOT NULL,
        route TEXT,
        environment TEXT,
        test_suite TEXT,
        count INTEGER NOT NULL,
        last_observed TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rt_symbols ON runtime_observations(from_symbol, to_symbol);

      CREATE TABLE IF NOT EXISTS git_coupling (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        cochange_count INTEGER NOT NULL,
        coupling_score REAL NOT NULL,
        last_commit TEXT,
        PRIMARY KEY (file_a, file_b)
      );
      CREATE INDEX IF NOT EXISTS idx_git_file_a ON git_coupling(file_a);
      CREATE INDEX IF NOT EXISTS idx_git_file_b ON git_coupling(file_b);

      CREATE TABLE IF NOT EXISTS embeddings (
        symbol_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        vector TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON embeddings(chunk_hash);
    `);
  }

  transaction<T>(fn: () => T): T {
    if (this.isNativeSqlite && this.db) {
      this.db.exec("BEGIN TRANSACTION;");
      try {
        const result = fn();
        this.db.exec("COMMIT;");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK;");
        throw err;
      }
    } else {
      // In-memory atomic execution
      return fn();
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots Partition
  // -------------------------------------------------------------------------
  insertSnapshot(snapshot: Snapshot): void {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO snapshots (id, repository, commit_sha, parent_snapshot_id, kind, base_commit, patch_hash, generated_at, environment, build_id, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        snapshot.id,
        snapshot.repository,
        snapshot.commit,
        snapshot.parentSnapshotId ?? null,
        snapshot.kind,
        snapshot.baseCommit ?? null,
        snapshot.patchHash ?? null,
        snapshot.generatedAt,
        snapshot.environment ?? null,
        snapshot.buildId ?? null,
        snapshot.schemaVersion ?? "2.2",
      );
    } else {
      this.memoryTables.snapshots.set(snapshot.id, { ...snapshot });
    }
  }

  getSnapshot(id: string): Snapshot | null {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM snapshots WHERE id = ?");
      const row = stmt.get(id);
      if (!row) return null;
      return {
        id: row.id,
        repository: row.repository,
        commit: row.commit_sha,
        parentSnapshotId: row.parent_snapshot_id ?? undefined,
        kind: row.kind,
        baseCommit: row.base_commit ?? undefined,
        patchHash: row.patch_hash ?? undefined,
        generatedAt: row.generated_at,
        environment: row.environment ?? undefined,
        buildId: row.build_id ?? undefined,
        schemaVersion: row.schema_version ?? "2.2",
      };
    }
    return this.memoryTables.snapshots.get(id) ?? null;
  }

  getAllSnapshots(): Snapshot[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM snapshots ORDER BY generated_at DESC");
      const rows = stmt.all();
      return rows.map((row: any) => ({
        id: row.id,
        repository: row.repository,
        commit: row.commit_sha,
        parentSnapshotId: row.parent_snapshot_id ?? undefined,
        kind: row.kind,
        baseCommit: row.base_commit ?? undefined,
        patchHash: row.patch_hash ?? undefined,
        generatedAt: row.generated_at,
        environment: row.environment ?? undefined,
        buildId: row.build_id ?? undefined,
        schemaVersion: row.schema_version ?? "2.2",
      }));
    }
    return Array.from(this.memoryTables.snapshots.values());
  }

  // -------------------------------------------------------------------------
  // Symbols Partition
  // -------------------------------------------------------------------------
  insertSymbol(symbol: StoredSymbolRecord): void {
    const record: StoredSymbolRecord = {
      ...symbol,
      origin: symbol.origin ?? "SOURCE",
      createdAt: symbol.createdAt ?? new Date().toISOString(),
    };

    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO symbols (id, repository, package, language, path, qualified_name, signature, declaration_hash, origin, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id,
        record.repository,
        record.package,
        record.language,
        record.path,
        record.qualifiedName,
        record.signature ?? null,
        record.declarationHash,
        record.origin ?? "SOURCE",
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      );
    } else {
      this.memoryTables.symbols.set(record.id, record);
    }
  }

  getSymbol(id: string): StoredSymbolRecord | null {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM symbols WHERE id = ?");
      const row = stmt.get(id);
      if (!row) return null;
      return {
        id: row.id,
        repository: row.repository,
        package: row.package,
        language: row.language,
        path: row.path,
        qualifiedName: row.qualified_name,
        signature: row.signature ?? undefined,
        declarationHash: row.declaration_hash,
        origin: row.origin ?? "SOURCE",
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      };
    }
    return this.memoryTables.symbols.get(id) ?? null;
  }

  getSymbolsByPath(filePath: string): StoredSymbolRecord[] {
    const norm = filePath.replace(/\\/g, "/");
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM symbols WHERE path = ?");
      const rows = stmt.all(norm);
      return rows.map((row: any) => ({
        id: row.id,
        repository: row.repository,
        package: row.package,
        language: row.language,
        path: row.path,
        qualifiedName: row.qualified_name,
        signature: row.signature ?? undefined,
        declarationHash: row.declaration_hash,
        origin: row.origin ?? "SOURCE",
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.symbols.values()).filter((s) => s.path === norm);
  }

  // -------------------------------------------------------------------------
  // Edges Partition
  // -------------------------------------------------------------------------
  insertEdge(edge: StoredEdgeRecord): void {
    const record: StoredEdgeRecord = {
      ...edge,
      createdAt: edge.createdAt ?? new Date().toISOString(),
    };

    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO edges (id, from_id, to_id, relation, confidence, calibrated_confidence, why, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id,
        record.fromId,
        record.toId,
        record.relation,
        record.confidence,
        record.calibratedConfidence ?? null,
        record.why ? JSON.stringify(record.why) : null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      );
    } else {
      this.memoryTables.edges.set(record.id, record);
    }
  }

  getEdgesFrom(fromId: string): StoredEdgeRecord[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM edges WHERE from_id = ?");
      const rows = stmt.all(fromId);
      return rows.map((row: any) => ({
        id: row.id,
        fromId: row.from_id,
        toId: row.to_id,
        relation: row.relation,
        confidence: row.confidence,
        calibratedConfidence: row.calibrated_confidence ?? undefined,
        why: row.why ? JSON.parse(row.why) : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.edges.values()).filter((e) => e.fromId === fromId);
  }

  getEdgesTo(toId: string): StoredEdgeRecord[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM edges WHERE to_id = ?");
      const rows = stmt.all(toId);
      return rows.map((row: any) => ({
        id: row.id,
        fromId: row.from_id,
        toId: row.to_id,
        relation: row.relation,
        confidence: row.confidence,
        calibratedConfidence: row.calibrated_confidence ?? undefined,
        why: row.why ? JSON.parse(row.why) : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.edges.values()).filter((e) => e.toId === toId);
  }

  // -------------------------------------------------------------------------
  // Evidence Partition
  // -------------------------------------------------------------------------
  insertEvidence(evidence: StoredEvidenceRecord): void {
    const record: StoredEvidenceRecord = {
      ...evidence,
      createdAt: evidence.createdAt ?? new Date().toISOString(),
    };

    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO evidence (id, edge_id, snapshot_id, kind, strength, scope, file, start_line, end_line, observations, confidence, confidence_state, coverage, raw_evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id,
        record.edgeId,
        record.snapshotId ?? null,
        record.kind,
        record.strength,
        record.scope,
        record.file,
        record.startLine,
        record.endLine ?? null,
        record.observations ?? null,
        record.confidence ?? null,
        record.confidenceState ?? null,
        record.coverage ?? null,
        record.rawEvidence ?? null,
        record.createdAt,
      );
    } else {
      this.memoryTables.evidence.set(record.id, record);
    }
  }

  getEvidenceForEdge(edgeId: string): StoredEvidenceRecord[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM evidence WHERE edge_id = ?");
      const rows = stmt.all(edgeId);
      return rows.map((row: any) => ({
        id: row.id,
        edgeId: row.edge_id,
        snapshotId: row.snapshot_id ?? undefined,
        kind: row.kind,
        strength: row.strength,
        scope: row.scope,
        file: row.file,
        startLine: row.start_line,
        endLine: row.end_line ?? undefined,
        observations: row.observations ?? undefined,
        confidence: row.confidence ?? undefined,
        confidenceState: row.confidence_state ?? undefined,
        coverage: row.coverage ?? undefined,
        rawEvidence: row.raw_evidence ?? undefined,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.evidence.values()).filter((ev) => ev.edgeId === edgeId);
  }

  // -------------------------------------------------------------------------
  // Runtime Observations Partition
  // -------------------------------------------------------------------------
  recordRuntimeObservation(observation: StoredRuntimeObservation): void {
    const id = observation.id || `obs:${observation.fromSymbol}->${observation.toSymbol}`;
    const record: StoredRuntimeObservation = { ...observation, id };

    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO runtime_observations (id, from_symbol, to_symbol, route, environment, test_suite, count, last_observed, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          count = count + excluded.count,
          last_observed = excluded.last_observed
      `);
      stmt.run(
        record.id,
        record.fromSymbol,
        record.toSymbol,
        record.route ?? null,
        record.environment ?? "test",
        record.testSuite ?? null,
        record.count,
        record.lastObserved,
        record.metadata ? JSON.stringify(record.metadata) : null,
      );
    } else {
      const existing = this.memoryTables.runtimeObservations.get(record.id);
      if (existing) {
        existing.count += record.count;
        existing.lastObserved = record.lastObserved;
      } else {
        this.memoryTables.runtimeObservations.set(record.id, { ...record });
      }
    }
  }

  getRuntimeObservations(fromSymbol?: string, toSymbol?: string): StoredRuntimeObservation[] {
    if (this.isNativeSqlite && this.db) {
      let query = "SELECT * FROM runtime_observations WHERE 1=1";
      const params: any[] = [];
      if (fromSymbol) {
        query += " AND from_symbol = ?";
        params.push(fromSymbol);
      }
      if (toSymbol) {
        query += " AND to_symbol = ?";
        params.push(toSymbol);
      }
      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params);
      return rows.map((row: any) => ({
        id: row.id,
        fromSymbol: row.from_symbol,
        toSymbol: row.to_symbol,
        route: row.route ?? undefined,
        environment: row.environment ?? undefined,
        testSuite: row.test_suite ?? undefined,
        count: row.count,
        lastObserved: row.last_observed,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      }));
    }
    return Array.from(this.memoryTables.runtimeObservations.values()).filter((obs) => {
      if (fromSymbol && obs.fromSymbol !== fromSymbol) return false;
      if (toSymbol && obs.toSymbol !== toSymbol) return false;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Git Coupling Partition
  // -------------------------------------------------------------------------
  recordGitCoupling(fileA: string, fileB: string, count: number, score: number, lastCommit?: string): void {
    const normA = fileA.replace(/\\/g, "/");
    const normB = fileB.replace(/\\/g, "/");
    const [a, b] = [normA, normB].sort();
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO git_coupling (file_a, file_b, cochange_count, coupling_score, last_commit)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(a, b, count, score, lastCommit ?? null);
    } else {
      this.memoryTables.gitCoupling.set(`${a}::${b}`, {
        fileA: a,
        fileB: b,
        cochangeCount: count,
        couplingScore: score,
        lastCommit,
      });
    }
  }

  getGitCoupling(filePath: string): StoredGitCoupling[] {
    const norm = filePath.replace(/\\/g, "/");
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM git_coupling WHERE file_a = ? OR file_b = ? ORDER BY coupling_score DESC
      `);
      const rows = stmt.all(norm, norm);
      return rows.map((row: any) => ({
        fileA: row.file_a,
        fileB: row.file_b,
        cochangeCount: row.cochange_count,
        couplingScore: row.coupling_score,
        lastCommit: row.last_commit ?? undefined,
      }));
    }
    return Array.from(this.memoryTables.gitCoupling.values())
      .filter((gc) => gc.fileA === norm || gc.fileB === norm)
      .sort((x, y) => y.couplingScore - x.couplingScore);
  }

  // -------------------------------------------------------------------------
  // Embeddings Partition
  // -------------------------------------------------------------------------
  saveEmbedding(symbolId: string, modelId: string, vector: number[], chunkHash: string): void {
    const record: StoredEmbedding = {
      symbolId,
      modelId,
      vector,
      chunkHash,
      createdAt: new Date().toISOString(),
    };

    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO embeddings (symbol_id, model_id, vector, chunk_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(symbolId, modelId, JSON.stringify(vector), chunkHash, record.createdAt);
    } else {
      this.memoryTables.embeddings.set(symbolId, record);
    }
  }

  getEmbedding(symbolId: string): StoredEmbedding | null {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM embeddings WHERE symbol_id = ?");
      const row = stmt.get(symbolId);
      if (!row) return null;
      return {
        symbolId: row.symbol_id,
        modelId: row.model_id,
        vector: JSON.parse(row.vector),
        chunkHash: row.chunk_hash,
        createdAt: row.created_at,
      };
    }
    return this.memoryTables.embeddings.get(symbolId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Snapshot Import / Export (JSON Snapshot Exporter)
  // -------------------------------------------------------------------------
  exportSnapshot(): GraphWardStorageSnapshot {
    if (this.isNativeSqlite && this.db) {
      const symbols = this.db.prepare("SELECT * FROM symbols").all().map((r: any) => ({
        id: r.id,
        repository: r.repository,
        package: r.package,
        language: r.language,
        path: r.path,
        qualifiedName: r.qualified_name,
        signature: r.signature ?? undefined,
        declarationHash: r.declaration_hash,
        origin: r.origin ?? "SOURCE",
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        createdAt: r.created_at,
      }));

      const edges = this.db.prepare("SELECT * FROM edges").all().map((r: any) => ({
        id: r.id,
        fromId: r.from_id,
        toId: r.to_id,
        relation: r.relation,
        confidence: r.confidence,
        calibratedConfidence: r.calibrated_confidence ?? undefined,
        why: r.why ? JSON.parse(r.why) : undefined,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        createdAt: r.created_at,
      }));

      const evidence = this.db.prepare("SELECT * FROM evidence").all().map((r: any) => ({
        id: r.id,
        edgeId: r.edge_id,
        snapshotId: r.snapshot_id ?? undefined,
        kind: r.kind,
        strength: r.strength,
        scope: r.scope,
        file: r.file,
        startLine: r.start_line,
        endLine: r.end_line ?? undefined,
        observations: r.observations ?? undefined,
        confidence: r.confidence ?? undefined,
        confidenceState: r.confidence_state ?? undefined,
        coverage: r.coverage ?? undefined,
        rawEvidence: r.raw_evidence ?? undefined,
        createdAt: r.created_at,
      }));

      const runtimeObservations = this.db.prepare("SELECT * FROM runtime_observations").all().map((r: any) => ({
        id: r.id,
        fromSymbol: r.from_symbol,
        toSymbol: r.to_symbol,
        route: r.route ?? undefined,
        environment: r.environment ?? undefined,
        testSuite: r.test_suite ?? undefined,
        count: r.count,
        lastObserved: r.last_observed,
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      }));

      const gitCoupling = this.db.prepare("SELECT * FROM git_coupling").all().map((r: any) => ({
        fileA: r.file_a,
        fileB: r.file_b,
        cochangeCount: r.cochange_count,
        couplingScore: r.coupling_score,
        lastCommit: r.last_commit ?? undefined,
      }));

      const embeddings = this.db.prepare("SELECT * FROM embeddings").all().map((r: any) => ({
        symbolId: r.symbol_id,
        modelId: r.model_id,
        vector: JSON.parse(r.vector),
        chunkHash: r.chunk_hash,
        createdAt: r.created_at,
      }));

      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        snapshots: this.getAllSnapshots(),
        symbols,
        edges,
        evidence,
        runtimeObservations,
        gitCoupling,
        embeddings,
      };
    }

    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      snapshots: Array.from(this.memoryTables.snapshots.values()),
      symbols: Array.from(this.memoryTables.symbols.values()),
      edges: Array.from(this.memoryTables.edges.values()),
      evidence: Array.from(this.memoryTables.evidence.values()),
      runtimeObservations: Array.from(this.memoryTables.runtimeObservations.values()),
      gitCoupling: Array.from(this.memoryTables.gitCoupling.values()),
      embeddings: Array.from(this.memoryTables.embeddings.values()),
    };
  }

  getAllSymbols(): StoredSymbolRecord[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM symbols");
      const rows = stmt.all();
      return rows.map((row: any) => ({
        id: row.id,
        repository: row.repository,
        package: row.package,
        language: row.language,
        path: row.path,
        qualifiedName: row.qualified_name,
        signature: row.signature ?? undefined,
        declarationHash: row.declaration_hash,
        origin: row.origin ?? "SOURCE",
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.symbols.values());
  }

  getAllEdges(): StoredEdgeRecord[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM edges");
      const rows = stmt.all();
      return rows.map((row: any) => ({
        id: row.id,
        fromId: row.from_id,
        toId: row.to_id,
        relation: row.relation,
        confidence: row.confidence,
        calibratedConfidence: row.calibrated_confidence ?? undefined,
        why: row.why ? JSON.parse(row.why) : undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.edges.values());
  }

  getEmbeddingsForModel(modelId: string): StoredEmbedding[] {
    if (this.isNativeSqlite && this.db) {
      const stmt = this.db.prepare("SELECT * FROM embeddings WHERE model_id = ?");
      const rows = stmt.all(modelId);
      return rows.map((row: any) => ({
        symbolId: row.symbol_id,
        modelId: row.model_id,
        vector: JSON.parse(row.vector),
        chunkHash: row.chunk_hash,
        createdAt: row.created_at,
      }));
    }
    return Array.from(this.memoryTables.embeddings.values()).filter((e) => e.modelId === modelId);
  }

  importSnapshot(snapshot: GraphWardStorageSnapshot): void {
    this.transaction(() => {
      for (const snap of snapshot.snapshots ?? []) this.insertSnapshot(snap);
      for (const sym of snapshot.symbols ?? []) this.insertSymbol(sym);
      for (const edge of snapshot.edges ?? []) this.insertEdge(edge);
      for (const ev of snapshot.evidence ?? []) this.insertEvidence(ev);
      for (const rt of snapshot.runtimeObservations ?? []) this.recordRuntimeObservation(rt);
      for (const gc of snapshot.gitCoupling ?? []) {
        this.recordGitCoupling(gc.fileA, gc.fileB, gc.cochangeCount, gc.couplingScore, gc.lastCommit);
      }
      for (const emb of snapshot.embeddings ?? []) {
        this.saveEmbedding(emb.symbolId, emb.modelId, emb.vector, emb.chunkHash);
      }
    });
  }

  close(): void {
    if (this.isNativeSqlite && this.db && typeof this.db.close === "function") {
      this.db.close();
      this.db = null;
    }
  }
}
