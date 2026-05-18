'use client';

import { useEffect, useState, useTransition } from 'react';
import { parse as parseYaml } from 'yaml';
import {
  POLICY_TEMPLATES,
  PolicyDocument,
  policyTemplateRulesYaml,
  policyTemplateStandaloneYaml,
  type PolicyEffect,
  type PolicyTemplate,
} from '@dejavas/shared';

type ValidationOk = {
  ok: true;
  rules: number;
  default: 'allow' | 'deny';
  counts: Record<PolicyEffect, number>;
};

type ValidationFail = {
  ok: false;
  kind: 'yaml' | 'schema';
  errors: { path: string; message: string }[];
};

type Validation = ValidationOk | ValidationFail | { ok: 'pending' };

function validate(yaml: string): ValidationOk | ValidationFail {
  if (!yaml.trim()) {
    return {
      ok: false,
      kind: 'yaml',
      errors: [{ path: '(document)', message: 'policy YAML is empty' }],
    };
  }
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    const e = err as { message?: string; linePos?: { line: number; col: number }[] };
    const where =
      e.linePos && e.linePos[0]
        ? `line ${e.linePos[0].line}, col ${e.linePos[0].col}`
        : 'unknown location';
    return {
      ok: false,
      kind: 'yaml',
      errors: [{ path: where, message: e.message ?? 'invalid YAML' }],
    };
  }
  const result = PolicyDocument.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      kind: 'schema',
      errors: result.error.issues.slice(0, 12).map((i) => ({
        path: i.path.length ? i.path.join('.') : '(root)',
        message: i.message,
      })),
    };
  }
  const counts: Record<PolicyEffect, number> = {
    allow: 0,
    require_approval: 0,
    deny: 0,
  };
  for (const rule of result.data.rules) counts[rule.effect]++;
  return {
    ok: true,
    rules: result.data.rules.length,
    default: result.data.default,
    counts,
  };
}

export interface PolicyEditorProps {
  initialName: string;
  initialYaml: string;
  action: (formData: FormData) => Promise<void>;
}

export function PolicyEditor({ initialName, initialYaml, action }: PolicyEditorProps) {
  const [name, setName] = useState(initialName);
  const [yaml, setYaml] = useState(initialYaml);
  const [validation, setValidation] = useState<Validation>(() => validate(initialYaml));
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setValidation({ ok: 'pending' });
    const t = setTimeout(() => setValidation(validate(yaml)), 200);
    return () => clearTimeout(t);
  }, [yaml]);

  const isValid = validation !== null && (validation as ValidationOk).ok === true;
  const isFail =
    validation !== null && (validation as ValidationFail).ok === false;

  function appendTemplate(template: PolicyTemplate) {
    const block = policyTemplateRulesYaml(template);
    setYaml((current) => {
      const trimmed = current.trimEnd();
      if (trimmed.length === 0) {
        return policyTemplateStandaloneYaml(template);
      }
      const needsNewline = trimmed.length > 0 && !trimmed.endsWith('\n');
      const separator = needsNewline ? '\n\n' : '\n';
      return `${trimmed}${separator}${block}`;
    });
  }

  function replaceWithTemplate(template: PolicyTemplate) {
    if (
      yaml.trim().length > 0 &&
      !window.confirm(
        `Replace the current policy with the "${template.label}" template? This clears the YAML in the editor — nothing is saved until you click Save and activate.`,
      )
    ) {
      return;
    }
    setYaml(policyTemplateStandaloneYaml(template));
  }

  return (
    <form
      className="flex flex-col gap-3"
      action={(fd) => startTransition(() => action(fd))}
    >
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)] max-w-xs flex-1">
          Policy name
          <input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <ValidationBadge validation={validation} />
      </div>

      <TemplatesPanel onInsert={appendTemplate} onReplace={replaceWithTemplate} />

      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        YAML
        <textarea
          name="yaml"
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          rows={20}
          spellCheck={false}
          className={`rounded-md border bg-[var(--color-bg)] px-3 py-2 text-sm mono focus:outline-none ${
            isFail
              ? 'border-rose-500/50 focus:border-rose-500'
              : isValid
                ? 'border-emerald-500/30 focus:border-emerald-500'
                : 'border-[var(--color-border)] focus:border-[var(--color-accent)]'
          }`}
        />
      </label>

      <ValidationDetail validation={validation} />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!isValid || pending}
          className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Saving…' : 'Save and activate'}
        </button>
        <span className="text-xs text-[var(--color-muted)]">
          Saving creates a new version and deactivates the previous active policy.
        </span>
      </div>
    </form>
  );
}

function ValidationBadge({ validation }: { validation: Validation }) {
  if (validation === null) return null;
  if ((validation as { ok: 'pending' }).ok === 'pending') {
    return (
      <span className="text-xs text-[var(--color-muted)] mono">checking…</span>
    );
  }
  if ((validation as ValidationOk).ok === true) {
    const v = validation as ValidationOk;
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
        <span className="mono text-[var(--color-muted)]">
          valid · {v.rules} rule{v.rules === 1 ? '' : 's'} · default={v.default}
        </span>
        <span className="mono text-[var(--color-muted)]">
          ({v.counts.allow} allow / {v.counts.require_approval} approval /{' '}
          {v.counts.deny} deny)
        </span>
      </span>
    );
  }
  const v = validation as ValidationFail;
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span className="inline-block w-2 h-2 rounded-full bg-rose-400" />
      <span className="mono text-rose-300">
        {v.kind === 'yaml' ? 'invalid YAML' : 'schema mismatch'} ·{' '}
        {v.errors.length} issue{v.errors.length === 1 ? '' : 's'}
      </span>
    </span>
  );
}

function TemplatesPanel({
  onInsert,
  onReplace,
}: {
  onInsert: (template: PolicyTemplate) => void;
  onReplace: (template: PolicyTemplate) => void;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h3 className="text-sm font-medium">Approval-gate templates</h3>
        <span className="text-xs text-[var(--color-muted)]">
          One-click rules for the common high-risk actions. Insert to append, replace to start fresh.
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {POLICY_TEMPLATES.map((template) => (
          <div
            key={template.key}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 flex flex-col gap-2"
          >
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">{template.label}</div>
              <div className="text-xs text-[var(--color-muted)]">
                {template.description}
              </div>
              <div className="text-xs mono text-[var(--color-muted)]">
                {template.rules.length} rule{template.rules.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="flex gap-2 mt-auto">
              <button
                type="button"
                onClick={() => onInsert(template)}
                className="px-2 py-1 rounded-md text-xs border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Insert
              </button>
              <button
                type="button"
                onClick={() => onReplace(template)}
                className="px-2 py-1 rounded-md text-xs border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Replace
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ValidationDetail({ validation }: { validation: Validation }) {
  if (validation === null || (validation as ValidationOk).ok === true) return null;
  if ((validation as { ok: 'pending' }).ok === 'pending') return null;
  const v = validation as ValidationFail;
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs">
      <div className="font-medium mb-2 text-rose-300">
        {v.kind === 'yaml' ? 'YAML parse errors' : 'Policy schema errors'}
      </div>
      <ul className="space-y-1 mono">
        {v.errors.map((e, i) => (
          <li key={i} className="text-rose-200">
            <span className="text-rose-400/80">{e.path}</span>{' '}
            <span className="text-rose-200/70">— {e.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
