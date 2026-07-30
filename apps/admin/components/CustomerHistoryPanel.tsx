"use client";

import { FormEvent, useEffect, useState } from "react";
import type { AppLocale } from "@hair-simo/i18n";
import { adminT } from "../lib/admin-messages";
import { formatSalonDate, formatSalonTime } from "../lib/admin-datetime";

type CustomerNoteKind = "general" | "formula" | "allergy" | "preference";
type AppointmentStatus = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";

type CustomerNoteView = {
  id: string;
  customerId: string;
  kind: CustomerNoteKind;
  text: string;
  raw: string;
  pinned: boolean;
  authorId: string | null;
  createdAt: string;
  createdAtLabel: string;
  updatedAt: string;
};

type FormulaRecord = {
  noteId: string;
  customerId: string;
  version: number;
  product: string;
  developer: string | null;
  ratio: string | null;
  processingMinutes: number | null;
  result: string | null;
  appointmentId: string | null;
  authorId: string | null;
  pinned: boolean;
  summary: string;
  recordedAt: string;
  recordedAtLabel: string;
};

type VisitSummary = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  timeLabel: string;
  status: AppointmentStatus;
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  priceCents: number;
  paidCents: number;
  notes: string | null;
};

type PreferredStaff = {
  staffId: string;
  displayName: string;
  visits: number;
  share: number;
  lastVisitAt: string;
};

type PreferredService = {
  serviceId: string;
  slug: string;
  name: string;
  visits: number;
  share: number;
};

type CustomerStats = {
  visitCount: number;
  upcomingCount: number;
  cancelledCount: number;
  noShowCount: number;
  noShowRate: number;
  lifetimeValueCents: number;
  paidOnlineCents: number;
  tipsCents: number;
  currency: "EUR";
  averageIntervalDays: number | null;
  daysSinceLastVisit: number | null;
  dueForRebooking: boolean;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  lastVisitLabel: string | null;
  nextAppointmentAt: string | null;
  nextAppointmentLabel: string | null;
};

type CustomerProfile = {
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    locale: string;
    marketingOptIn: boolean;
    customerSince: string;
    customerSinceLabel: string;
  };
  hasAllergies: boolean;
  allergies: CustomerNoteView[];
  pinned: CustomerNoteView[];
  notes: CustomerNoteView[];
  noteCounts: {
    total: number;
    general: number;
    formula: number;
    allergy: number;
    preference: number;
  };
  latestFormula: FormulaRecord | null;
  formulaHistory: FormulaRecord[];
  preferredStaff: PreferredStaff | null;
  preferredService: PreferredService | null;
  stats: CustomerStats;
  lastVisit: VisitSummary | null;
  nextAppointment: VisitSummary | null;
  recentVisits: VisitSummary[];
  windowMonths: number;
  generatedAt: string;
};

type AddNoteForm = {
  kind: CustomerNoteKind;
  pinned: boolean;
  text: string;
  product: string;
  developer: string;
  ratio: string;
  processingMinutes: string;
  result: string;
};

const NOTE_KINDS: CustomerNoteKind[] = ["general", "formula", "allergy", "preference"];

function emptyAddForm(): AddNoteForm {
  return {
    kind: "general",
    pinned: false,
    text: "",
    product: "",
    developer: "",
    ratio: "",
    processingMinutes: "",
    result: "",
  };
}

function kindLabel(locale: AppLocale, kind: CustomerNoteKind): string {
  if (kind === "formula") return adminT(locale, "history_kind_formula");
  if (kind === "allergy") return adminT(locale, "history_kind_allergy");
  if (kind === "preference") return adminT(locale, "history_kind_preference");
  return adminT(locale, "history_kind_general");
}

function formatEuros(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function formulaSummaryText(parts: {
  product: string;
  developer: string;
  ratio: string;
  minutes: number | null;
  result: string;
}): string {
  const pieces = [parts.product];
  if (parts.developer) pieces.push(parts.developer);
  if (parts.ratio) pieces.push(parts.ratio);
  if (parts.minutes) pieces.push(`${parts.minutes} min`);
  if (parts.result) pieces.push(parts.result);
  return pieces.join(" | ");
}

function buildFormulaNote(form: AddNoteForm, appointmentId?: string): string | null {
  const product = form.product.trim();
  if (!product) return null;
  const developer = form.developer.trim();
  const ratio = form.ratio.trim();
  const result = form.result.trim();
  const minutesValue = Number(form.processingMinutes);
  const minutes =
    form.processingMinutes.trim() !== "" && Number.isFinite(minutesValue) && minutesValue > 0
      ? Math.round(minutesValue)
      : null;
  const payload: Record<string, unknown> = {
    v: 1,
    product,
    text: formulaSummaryText({ product, developer, ratio, minutes, result }),
  };
  if (developer) payload.developer = developer;
  if (ratio) payload.ratio = ratio;
  if (minutes) payload.processingMinutes = minutes;
  if (result) payload.result = result;
  if (appointmentId) payload.appointmentId = appointmentId;
  return JSON.stringify(payload);
}

export function CustomerHistoryPanel({
  customerId,
  locale,
  appointmentId,
}: {
  customerId: string;
  locale: AppLocale;
  appointmentId?: string;
}) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<AddNoteForm>(emptyAddForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ note: "", pinned: false });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function loadProfile() {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/customers/${customerId}/history?locale=${locale}`);
      const json = await response.json();
      if (!response.ok) {
        setLoadError(json.message ?? json.error ?? adminT(locale, "history_load_error"));
        setProfile(null);
        return;
      }
      setProfile(json.data as CustomerProfile);
    } catch {
      setLoadError(adminT(locale, "history_load_error"));
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setShowAdd(false);
    setAddForm(emptyAddForm());
    setEditingId(null);
    setConfirmDeleteId(null);
    setFeedback(null);
    void loadProfile();
  }, [customerId]);

  async function submitNote(event: FormEvent) {
    event.preventDefault();
    const note = addForm.kind === "formula" ? buildFormulaNote(addForm, appointmentId) : addForm.text.trim();
    if (!note) return;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/customers/${customerId}/history/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          kind: addForm.kind,
          pinned: addForm.kind === "allergy" ? true : addForm.pinned,
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        setFeedback({ type: "error", text: json.message ?? adminT(locale, "history_action_failed") });
        return;
      }
      setFeedback({ type: "success", text: adminT(locale, "history_note_saved") });
      setShowAdd(false);
      setAddForm(emptyAddForm());
      await loadProfile();
    } catch {
      setFeedback({ type: "error", text: adminT(locale, "history_action_failed") });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(note: CustomerNoteView) {
    setEditingId(note.id);
    setEditDraft({ note: note.raw, pinned: note.pinned });
    setConfirmDeleteId(null);
  }

  async function saveEdit(note: CustomerNoteView) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/customers/${customerId}/history/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: editDraft.note,
          pinned: note.kind === "allergy" ? true : editDraft.pinned,
        }),
      });
      const json = await response.json();
      if (!response.ok) {
        setFeedback({ type: "error", text: json.message ?? adminT(locale, "history_action_failed") });
        return;
      }
      setFeedback({ type: "success", text: adminT(locale, "history_note_saved") });
      setEditingId(null);
      await loadProfile();
    } catch {
      setFeedback({ type: "error", text: adminT(locale, "history_action_failed") });
    } finally {
      setBusy(false);
    }
  }

  async function deleteNote(note: CustomerNoteView, confirmed = false) {
    if (note.kind === "allergy" && !confirmed) {
      setConfirmDeleteId(note.id);
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/customers/${customerId}/history/notes/${note.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note.kind === "allergy" ? { confirmAllergyDeletion: true } : {}),
      });
      const json = await response.json();
      if (!response.ok) {
        setFeedback({ type: "error", text: json.message ?? adminT(locale, "history_action_failed") });
        return;
      }
      setFeedback({ type: "success", text: adminT(locale, "history_note_deleted") });
      setConfirmDeleteId(null);
      await loadProfile();
    } catch {
      setFeedback({ type: "error", text: adminT(locale, "history_action_failed") });
    } finally {
      setBusy(false);
    }
  }

  function renderNote(note: CustomerNoteView, showKind = true) {
    const isEditing = editingId === note.id;
    const isConfirmingDelete = confirmDeleteId === note.id;
    return (
      <div className="admin-note" key={note.id}>
        {isEditing ? (
          <>
            <textarea
              className="admin-textarea"
              value={editDraft.note}
              onChange={(event) => setEditDraft((current) => ({ ...current, note: event.target.value }))}
            />
            <div>
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={note.kind === "allergy" ? true : editDraft.pinned}
                  disabled={note.kind === "allergy"}
                  onChange={(event) => setEditDraft((current) => ({ ...current, pinned: event.target.checked }))}
                />
                {adminT(locale, "history_note_pinned_label")}
              </label>
              <button className="admin-button" type="button" disabled={busy} onClick={() => void saveEdit(note)}>
                {adminT(locale, "history_save")}
              </button>
              <button className="admin-button secondary" type="button" onClick={() => setEditingId(null)}>
                {adminT(locale, "history_cancel")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              {showKind ? <span className="admin-kicker">{kindLabel(locale, note.kind)} </span> : null}
              {note.text}
            </p>
            <div>
              <time>{note.createdAtLabel}</time>
              <button className="admin-button secondary" type="button" onClick={() => startEdit(note)}>
                {adminT(locale, "history_edit")}
              </button>
              {isConfirmingDelete ? (
                <>
                  <span className="admin-form-error">{adminT(locale, "history_allergy_delete_confirm")}</span>
                  <button
                    className="admin-button danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void deleteNote(note, true)}
                  >
                    {adminT(locale, "history_allergy_delete_confirm_button")}
                  </button>
                  <button className="admin-button secondary" type="button" onClick={() => setConfirmDeleteId(null)}>
                    {adminT(locale, "history_cancel")}
                  </button>
                </>
              ) : (
                <button
                  className={note.kind === "allergy" ? "admin-button danger" : "admin-button secondary"}
                  type="button"
                  disabled={busy}
                  onClick={() => void deleteNote(note)}
                >
                  {adminT(locale, "history_delete")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  if (loading) {
    return <div className="admin-empty">{adminT(locale, "history_loading")}</div>;
  }

  if (loadError || !profile) {
    return <div className="admin-empty admin-form-error">{loadError ?? adminT(locale, "history_load_error")}</div>;
  }

  const pinnedNotes = profile.pinned.filter((note) => note.kind !== "formula");
  const generalNotes = profile.notes.filter((note) => note.kind === "general");
  const preferenceNotes = profile.notes.filter((note) => note.kind === "preference");
  const visibleNoteCount = pinnedNotes.length + generalNotes.length + preferenceNotes.length;
  const previousFormulas = profile.formulaHistory.slice(1);

  return (
    <div className="admin-history-panel">
      {profile.hasAllergies ? (
        <div
          role="alert"
          style={{
            border: "2px solid var(--admin-danger)",
            background: "rgba(189, 85, 77, 0.08)",
            padding: "14px 16px",
            marginBottom: "20px",
          }}
        >
          <h3 className="admin-negative" style={{ margin: "0 0 8px" }}>
            {adminT(locale, "history_allergies_heading")}
          </h3>
          <p className="admin-negative" style={{ margin: "0 0 10px" }}>
            {adminT(locale, "history_allergies_warning")}
          </p>
          {profile.allergies.map((note) => renderNote(note, false))}
        </div>
      ) : (
        <p className="admin-positive">{adminT(locale, "history_no_allergies")}</p>
      )}

      <div className="admin-detail-block">
        <h3>{adminT(locale, "history_formula_heading")}</h3>
        {profile.latestFormula ? (
          <div className="admin-note">
            <p>{profile.latestFormula.summary}</p>
            <time>{profile.latestFormula.recordedAtLabel}</time>
          </div>
        ) : (
          <div className="admin-empty">{adminT(locale, "history_formula_none")}</div>
        )}
        {previousFormulas.length > 0 ? (
          <details>
            <summary>
              {adminT(locale, "history_formula_previous")} ({previousFormulas.length})
            </summary>
            {previousFormulas.map((formula) => (
              <div className="admin-note" key={formula.noteId}>
                <p>{formula.summary}</p>
                <time>{formula.recordedAtLabel}</time>
              </div>
            ))}
          </details>
        ) : null}
      </div>

      <div className="admin-detail-block">
        <h3>{adminT(locale, "history_stats_heading")}</h3>
        <div className="admin-metric-grid">
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_visits")}</p>
            <strong>{profile.stats.visitCount}</strong>
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_lifetime_value")}</p>
            <strong>{formatEuros(profile.stats.lifetimeValueCents)}</strong>
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_no_shows")}</p>
            <strong>{profile.stats.noShowCount}</strong>
            <small>{formatPercent(profile.stats.noShowRate)}</small>
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_avg_interval")}</p>
            <strong>{profile.stats.averageIntervalDays ?? "—"}</strong>
            {profile.stats.averageIntervalDays !== null ? <small>{adminT(locale, "history_days_unit")}</small> : null}
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_preferred_staff")}</p>
            <strong>{profile.preferredStaff?.displayName ?? "—"}</strong>
            {profile.preferredStaff ? <small>{formatPercent(profile.preferredStaff.share)}</small> : null}
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_preferred_service")}</p>
            <strong>{profile.preferredService?.name ?? "—"}</strong>
            {profile.preferredService ? <small>{formatPercent(profile.preferredService.share)}</small> : null}
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_last_visit")}</p>
            <strong>{profile.stats.lastVisitLabel ?? "—"}</strong>
          </div>
          <div className="admin-metric">
            <p>{adminT(locale, "history_stat_next_appointment")}</p>
            <strong>{profile.stats.nextAppointmentLabel ?? "—"}</strong>
          </div>
        </div>
      </div>

      <div className="admin-detail-block">
        <h3>{adminT(locale, "history_visits_heading")}</h3>
        {profile.recentVisits.length === 0 ? (
          <div className="admin-empty">{adminT(locale, "history_no_visits")}</div>
        ) : (
          profile.recentVisits.map((visit) => (
            <div className="admin-history-row" key={visit.appointmentId}>
              <span>
                {formatSalonDate(visit.startsAt, locale)}{" "}
                <small className="admin-table-subline">{formatSalonTime(visit.startsAt, locale)}</small>
              </span>
              <span>{visit.serviceName}</span>
              <span>{visit.staffName ?? adminT(locale, "history_unassigned")}</span>
              <span className={`admin-status ${visit.status}`}>{visit.status.replace("_", " ")}</span>
            </div>
          ))
        )}
      </div>

      <div className="admin-detail-block">
        <div className="admin-section-header">
          <h3>{adminT(locale, "history_notes_heading")}</h3>
          <button className="admin-button secondary" type="button" onClick={() => setShowAdd((value) => !value)}>
            {adminT(locale, "history_add_note")}
          </button>
        </div>

        {showAdd ? (
          <form className="admin-form-grid" onSubmit={(event) => void submitNote(event)}>
            <div className="admin-form-split">
              <label>
                {adminT(locale, "history_note_kind_label")}
                <select
                  className="admin-select"
                  value={addForm.kind}
                  onChange={(event) => {
                    const kind = event.target.value as CustomerNoteKind;
                    setAddForm((current) => ({
                      ...current,
                      kind,
                      pinned: kind === "allergy" ? true : current.pinned,
                    }));
                  }}
                >
                  {NOTE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kindLabel(locale, kind)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={addForm.kind === "allergy" ? true : addForm.pinned}
                  disabled={addForm.kind === "allergy"}
                  onChange={(event) => setAddForm((current) => ({ ...current, pinned: event.target.checked }))}
                />
                {adminT(locale, "history_note_pinned_label")}
              </label>
            </div>
            {addForm.kind === "allergy" ? (
              <p className="admin-form-error">{adminT(locale, "history_note_allergy_pinned_hint")}</p>
            ) : null}

            {addForm.kind === "formula" ? (
              <div className="admin-form-split">
                <label>
                  {adminT(locale, "history_formula_product")}
                  <input
                    className="admin-field"
                    value={addForm.product}
                    onChange={(event) => setAddForm((current) => ({ ...current, product: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  {adminT(locale, "history_formula_developer")}
                  <input
                    className="admin-field"
                    value={addForm.developer}
                    onChange={(event) => setAddForm((current) => ({ ...current, developer: event.target.value }))}
                  />
                </label>
                <label>
                  {adminT(locale, "history_formula_ratio")}
                  <input
                    className="admin-field"
                    value={addForm.ratio}
                    onChange={(event) => setAddForm((current) => ({ ...current, ratio: event.target.value }))}
                  />
                </label>
                <label>
                  {adminT(locale, "history_formula_processing")}
                  <input
                    className="admin-field"
                    type="number"
                    min="1"
                    max="240"
                    value={addForm.processingMinutes}
                    onChange={(event) =>
                      setAddForm((current) => ({ ...current, processingMinutes: event.target.value }))
                    }
                  />
                </label>
                <label>
                  {adminT(locale, "history_formula_result")}
                  <input
                    className="admin-field"
                    value={addForm.result}
                    onChange={(event) => setAddForm((current) => ({ ...current, result: event.target.value }))}
                  />
                </label>
              </div>
            ) : (
              <label>
                {adminT(locale, "history_note_text_label")}
                <textarea
                  className="admin-textarea"
                  value={addForm.text}
                  onChange={(event) => setAddForm((current) => ({ ...current, text: event.target.value }))}
                  placeholder={adminT(locale, "history_note_placeholder")}
                  required
                />
              </label>
            )}

            <div>
              <button className="admin-button" type="submit" disabled={busy}>
                {adminT(locale, "history_note_save")}
              </button>
              <button className="admin-button secondary" type="button" onClick={() => setShowAdd(false)}>
                {adminT(locale, "history_cancel")}
              </button>
            </div>
          </form>
        ) : null}

        {pinnedNotes.length > 0 ? (
          <div>
            <h4>{adminT(locale, "history_notes_pinned")}</h4>
            {pinnedNotes.map((note) => renderNote(note))}
          </div>
        ) : null}

        {generalNotes.length > 0 ? (
          <div>
            <h4>{kindLabel(locale, "general")}</h4>
            {generalNotes.map((note) => renderNote(note, false))}
          </div>
        ) : null}

        {preferenceNotes.length > 0 ? (
          <div>
            <h4>{kindLabel(locale, "preference")}</h4>
            {preferenceNotes.map((note) => renderNote(note, false))}
          </div>
        ) : null}

        {visibleNoteCount === 0 ? <div className="admin-empty">{adminT(locale, "history_no_notes")}</div> : null}
      </div>

      {feedback ? (
        <p className={feedback.type === "success" ? "admin-inline-message" : "admin-form-error"}>{feedback.text}</p>
      ) : null}
    </div>
  );
}
