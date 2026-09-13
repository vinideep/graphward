# Dangerous Areas
<!-- freshness: last_checked=2026-09-03 -->

- Regex-based native import/API scanning may silently under-detect syntax and should be treated as fallback evidence, not proof of completeness. (evidence: src/graph/parsers/imports.ts, src/gates/api-diff.ts)
- Provider CLI formats are upstream contracts; all output parsing must fail closed into explicit native fallback rather than fabricate evidence. (evidence: src/providers/graphify.ts, src/providers/cce.ts)
- CCE overfetch can leak unrelated chunks unless both path scope and current span hash are enforced. (evidence: src/providers/cce.ts)
- Provider virtual environments cannot be relocated after installation; activation must point to the immutable final release. (evidence: src/providers/manager.ts)
- Managed adapter files can contain user changes; broad overwrite or deletion requires explicit force and inventory proof. (evidence: src/installer/index.ts, src/validation/index.ts)
- Knowledge freshness based only on timestamps is insufficient; material statements also need claim/source hash verification. (evidence: src/freshness/index.ts, src/evidence/index.ts, src/claims/index.ts)
