# Night Shift Worker stalls after normal database shrink

## Observed failure

Shared VLab completed a native two-stage Workboard DAG in 73.983 seconds and 64 ordinary tool/reply checks during a 30-job elastic batch. Night Shift cards later blocked because their Workers stopped sending heartbeats during `memory_search` and were terminated after 120 seconds. These attempts are failed evidence, not a completed batch acceptance.

The Makaron database had the same Gateway epoch, inode, owner and schema identity as its full-check receipt, but incremental vacuum reduced its physical size from the recorded minimum 7,690,919,936 bytes to 7,684,620,288 bytes. The existing gate rejected the receipt solely because the file was smaller. Memory's separately managed connections therefore re-entered synchronous full verification of the 7.7 GB database. The current database reports `auto_vacuum=2`, 1,876,128 pages and 4,096 bytes/page, exactly matching the smaller physical file.

## Change and boundaries

When the file shrinks, reuse still requires the existing private receipt, unchanged Gateway epoch, revocation fence, age, database ownership, inode and full schema identity. In addition, the shrink path requires:

- SQLite full or incremental auto-vacuum mode;
- a valid, committed SQLite main-file header with matching change counter and version-valid-for value;
- valid, matching page sizes and a whole number of physical pages;
- both the header page count and the current SQLite logical page count fully contained in the physical file.

Unknown, partial or externally truncated images remain cache misses and follow native full verification. Reuse does not rewrite the receipt, extend its checked time or clear revocation. Startup, migration/repair checks and the background verifier remain enabled.

SQLite documents file shrink for [auto-vacuum](https://sqlite.org/pragma.html#pragma_auto_vacuum), and the committed page-count header contract in its [file format](https://sqlite.org/fileformat.html#in_header_database_size).

## Verification

- 23 focused real-SQLite gate tests passed, including WAL/checkpoint shrink under both auto-vacuum modes and raw truncation of an auto-vacuum database.
- The wider existing integrity suite passed 47 tests; eight unchanged installer tests were skipped because their unpatched 9.1 bundle fixture was not supplied.
- Candidate `candidate-e529f254-3e48-4103-a891-bb6e749118ac` passed against the actual shared database: old cache miss reproduced, candidate guarded reuse took 1.85 ms, full native integrity verification passed in 57.957 seconds, zero shared database writes and unchanged Gateway PID. Candidate file SHA-256: `ebf5d3f0d43531a90ae04bf157a284c3d3f224e00b8c8695e1a810e7597a2883`.
- Final shared acceptance must rerun native card advancement, the 30-job elastic batch, real memory/exec/completion results and ordinary Sessions on the deployed artifact.
