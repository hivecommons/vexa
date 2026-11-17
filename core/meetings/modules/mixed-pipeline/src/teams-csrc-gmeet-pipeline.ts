import {
  GmeetCompatibleBuffer,
  type GmeetCompatibleBufferConfig,
  type GmeetCompatibleSubmissionTrigger,
} from '@vexa/transcribe-buffer';
import type { TranscriptionResult } from '@vexa/transcribe-whisper';
import { teamsWindowHallucinationRule } from './hallucination-gate.js';
import {
  detectTeamsWordContest,
  type TeamsContestSubmission,
  type TeamsRoutedSpan,
  type TeamsWordContest,
} from './teams-contested-word-marker.js';
import {
  TeamsCsrcChannelizer,
  type TeamsCsrcChannelizerHealth,
  type TeamsCsrcVirtualFrame,
} from './teams-csrc-channelizer.js';
import type { TransportEvent } from './turn-source.js';
import type { MissingRange } from './chunked-transcriber.js';
import { TrackNamer } from './track-namer.js';

export interface TeamsCsrcTranscriptSegment {
  csrc: number;
  /** Human name earned by the existing Teams track namer, or its stable Speaker A/B fallback. */
  speaker: string;
  sourceKey: string;
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  completed: boolean;
  language?: string;
}

export interface TeamsCsrcGmeetPipelineOptions {
  transcribe: (
    pcm: Float32Array,
    prompt?: string,
    context?: {
      csrc: number;
      sourceKey: string;
      forced: boolean;
      trigger: 'scheduled' | 'forced' | 'buffer';
      bufferTrigger: GmeetCompatibleSubmissionTrigger;
    },
  ) => Promise<TranscriptionResult>;
  onSegment: (segment: TeamsCsrcTranscriptSegment) => void;
  onRejectedOwnership?: (segment: TeamsCsrcTranscriptSegment, intervals: CsrcOwnershipInterval[]) => void;
  /** A confirmed segment lay outside its CSRC's interval and was published anyway, because no
   *  other lane was routed any of its audio. `offsetMs` is how far the segment's start (capture
   *  clock) sits before the nearest interval start (transport clock): the clocks' disagreement. */
  onUncontestedOwnership?: (segment: TeamsCsrcTranscriptSegment, offsetMs: number, intervals: CsrcOwnershipInterval[]) => void;
  /** Evaluation/telemetry seam: every frame the smoothed channelizer actually routes. */
  onRoutedFrame?: (frame: TeamsCsrcVirtualFrame) => void;
  onError?: (error: unknown) => void;
  /** Our own Teams display name; the existing namer excludes it from human identity. */
  selfName?: string;
  /** CSRC activation may arrive after its first PCM callback. Default: 600 ms. */
  lookbackMs?: number;
  /** Whisper segment may begin before Teams reports CSRC activation. Default: 1200 ms. */
  ownershipLookbackMs?: number;
  /** A short false/true flicker below this gap keeps the same continuous GMeet window. Default: 1000 ms. */
  onsetGapMs?: number;
  /** Hold a nested new CSRC provisionally before it receives mixed PCM. Default: 1500 ms. */
  flickerHoldMs?: number;
  /** Maximum Whisper segment overhang past a CSRC ownership edge. Default: 600 ms. */
  ownershipSlackMs?: number;
  /** Persist the latest clean GMeet draft if confirmation has not arrived. Default: 4000 ms. */
  persistTimeoutMs?: number;
  /** GMeet-compatible window tuning. Defaults are identical to Google Meet. */
  buffer?: GmeetCompatibleBufferConfig;
  /** A failed STT request is kept and sent again after this delay, doubling up to sttRetryMaxMs, for
   *  as long as the lane runs — captured audio is never given up to a transient outage.
   *  Defaults 5000 / 60000. */
  sttRetryBaseMs?: number;
  sttRetryMaxMs?: number;
  /** After dispose begins, failed requests are retried back to back until this deadline (ms); then
   *  the window is given up and the loss is reported through onError. Default 120000. */
  finalPassMs?: number;
  /** How much speech (ms of energetic mixed audio) may arrive with NO transport edge at all before
   *  the lane stops waiting for CSRC and routes the mix to one fallback lane. Default
   *  TEAMS_NO_TRANSPORT_FALLBACK_MS; Infinity disables the fallback. */
  noTransportFallbackMs?: number;
  /** The fallback lane engaged (no CSRC ever seen) or disengaged (the first CSRC edge arrived). */
  onNoTransportFallback?: (event: TeamsNoTransportFallbackEvent) => void;
}

export interface TeamsNoTransportFallbackEvent {
  engaged: boolean;
  tMs: number;
  /** Capture time between the first mixed frame and this event. */
  waitedMs: number;
  /** Frames the fallback lane routed to transcription before this event. */
  routedFrames: number;
}

/**
 * The virtual lane the mix rides when the transport never reports a contributing source. A real
 * CSRC is a uint32, so -1 can never collide with one, and it still reads as a number everywhere
 * a CSRC is expected (speaker_key `csrc:-1`, the namer's track id `-1`).
 */
export const TEAMS_NO_TRANSPORT_LANE = -1;

/**
 * How much SPEECH (ms of energetic mixed audio) may arrive with no CSRC edge before the lane
 * transcribes the mix without one.
 *
 * CSRC routing alone would leave a meeting whose transport never names a contributing source (a
 * client that does not mix server-side, a receiver the poll cannot read, a renamed accessor) with
 * ZERO routed frames: audio heard, nothing sent to STT. Long enough that a working transport always
 * speaks first (its first edge arrives within a packet train of the first word), short enough that
 * a lane without one starts transcribing within seconds of the first speech.
 */
export const TEAMS_NO_TRANSPORT_FALLBACK_MS = 3000;

/** Peak below which a fallback frame is silence and is not routed — the same gate the per-track
 *  page capture applies, so the fallback lane carries speech stretches, not a continuous hiss. */
export const TEAMS_FALLBACK_SILENCE_PEAK = 0.005;

/**
 * Largest capture-clock vs transport-clock offset (ms) at which a misfit final may still be
 * published under the lane's name. Real skew is a stalled page thread or a re-anchor, well under
 * this; anything larger is not a clock disagreement, so the row is refused.
 */
export const TEAMS_UNCONTESTED_MAX_OFFSET_MS = 5000;

/**
 * Another lane's routed audio within this many ms of a misfit span (capture clock) counts as
 * competing for it, even if the two spans do not overlap: a late frame of the previous speaker
 * lands in the next speaker's lane with a gap between the routed spans.
 */
export const TEAMS_COMPETING_LANE_MARGIN_MS = 5000;

export interface TeamsCsrcGmeetPipelineHealth extends TeamsCsrcChannelizerHealth {
  turns: number;
  /** Turn keys the shared GMeet window still holds a buffer and a submission timer for. Bounded by
   *  the number of concurrently active CSRC lanes, never by the meeting's turn count. */
  openSources: number;
  inFlight: number;
  rejectedOwnership: number;
  /** Confirmed segments outside their CSRC interval that were published because the lane was the
   *  only one routed that audio. Non-zero means the capture and transport clocks disagree. */
  uncontestedOwnership: number;
  timeoutPromotions: number;
  contestedPairs: number;
  /** True while the mix rides the no-transport fallback lane. */
  noTransportFallback: boolean;
  /** Frames the fallback lane routed to transcription. */
  fallbackFrames: number;
}

export interface CsrcOwnershipInterval { startMs: number; endMs?: number }

/** Deterministic fail-closed check used before a confirmed segment may leave a CSRC lane. */
export function spanFitsCsrcOwnership(
  intervals: CsrcOwnershipInterval[],
  startMs: number,
  endMs: number,
  lookbackMs = 600,
  endSlackMs = 400,
  bridgeGapMs = 1000,
): boolean {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return false;
  const ordered = intervals.slice().sort((a, b) => a.startMs - b.startMs);
  const merged: CsrcOwnershipInterval[] = [];
  for (const interval of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...interval });
      continue;
    }
    const previousEnd = previous.endMs ?? Number.POSITIVE_INFINITY;
    if (interval.startMs <= previousEnd + bridgeGapMs) {
      previous.endMs = previous.endMs === undefined || interval.endMs === undefined
        ? undefined
        : Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged.some((interval) => {
    const end = interval.endMs ?? Number.POSITIVE_INFINITY;
    return startMs >= interval.startMs - lookbackMs && endMs <= end + endSlackMs;
  });
}

interface TrackState {
  key: string;
  turn: number;
  lastAudioMs: number;
}

interface PendingDraft {
  sourceKey: string;
  segmentId: string;
  text: string;
  startMs: number;
  language?: string;
}

/**
 * Microsoft Teams candidate: raw transport activity becomes persistent virtual channels, then
 * every virtual channel is driven by the faithful shared copy of Google Meet's transcription
 * window. There is no Pyannote, diarization, voiceprint, or Whisper-timestamp ownership here.
 *
 * Teams supplies one decoded server mix, not pre-mix audio per CSRC. Consequently overlap routes
 * the same immutable PCM to each active window. This is deliberately visible in the experiment:
 * whether each window's prompt/continuity makes Whisper follow its established speaker is an
 * empirical property, never claimed as acoustic source separation.
 *
 * Time-and-word duplicates across simultaneously active CSRC lanes are detected post-confirm for
 * telemetry. Both rows remain, their public text stays verbatim, and no winner is inferred. The
 * shared GMeet-compatible buffer is unchanged; the deferred embedding resolver is documented in
 * ../TEAMS_CSRC_CONTESTED_TRANSCRIPTS.md.
 */
export class TeamsCsrcGmeetPipeline {
  private readonly manager: GmeetCompatibleBuffer;
  private readonly channelizer: TeamsCsrcChannelizer;
  private readonly trackNamer: TrackNamer;
  private readonly tracks = new Map<number, TrackState>();
  private readonly sourceToCsrc = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly closing = new Set<Promise<void>>();
  private readonly onsetGapMs: number;
  private readonly lookbackMs: number;
  private readonly ownershipLookbackMs: number;
  private readonly ownershipSlackMs: number;
  private readonly persistTimeoutMs: number;
  private readonly ownership = new Map<number, CsrcOwnershipInterval[]>();
  private readonly pendingDrafts = new Map<string, PendingDraft>();
  private readonly promotedDraftIds = new Set<string>();
  private readonly sourceLastAudioMs = new Map<string, number>();
  /** Latest public row by stable id, retained only so a late proven name can repaint it. */
  private readonly published = new Map<string, TeamsCsrcTranscriptSegment>();
  /** Verbatim rows are the evidence source; diagnostic contest notation never enters public text. */
  private readonly rawPublished = new Map<string, TeamsCsrcTranscriptSegment>();
  private readonly contestSubmissions: TeamsContestSubmission[] = [];
  private readonly routedSpans: TeamsRoutedSpan[] = [];
  private readonly latestRoutedSpan = new Map<number, TeamsRoutedSpan>();
  private readonly contests = new Map<string, TeamsWordContest>();
  private turnCount = 0;
  /** Windows given up after the final-pass deadline — recorded, never silent. */
  private readonly missing: MissingRange[] = [];
  private rejectedOwnership = 0;
  private uncontestedOwnership = 0;
  private timeoutPromotions = 0;
  private readonly noTransportFallbackMs: number;
  /** Capture time of the first mixed frame — the fallback's wait is measured from it. */
  private firstAudioMs: number | undefined;
  /** Set by the first transport edge; from then on CSRC alone routes audio. */
  private transportSeen = false;
  private fallbackActive = false;
  /** Whether the fallback track is currently "speaking" for the namer (energy-driven edges). */
  private fallbackSpeaking = false;
  private fallbackLastEnergyMs = Number.NEGATIVE_INFINITY;
  private fallbackFrames = 0;
  /** Speech held while the fallback waits to arm, routed on engagement. */
  private readonly fallbackHeld: Array<{ pcm: Float32Array; tsMs: number }> = [];
  private fallbackHeldMs = 0;

  constructor(private readonly options: TeamsCsrcGmeetPipelineOptions) {
    this.onsetGapMs = Math.max(0, options.onsetGapMs ?? 1000);
    this.lookbackMs = Math.max(0, options.lookbackMs ?? 600);
    this.ownershipLookbackMs = Math.max(0, options.ownershipLookbackMs ?? 1200);
    this.ownershipSlackMs = Math.max(0, options.ownershipSlackMs ?? 600);
    this.persistTimeoutMs = Math.max(0, options.persistTimeoutMs ?? 4000);
    this.noTransportFallbackMs = Math.max(0, options.noTransportFallbackMs ?? TEAMS_NO_TRANSPORT_FALLBACK_MS);
    this.trackNamer = new TrackNamer({
      selfName: options.selfName,
      // Teams sometimes exposes a media/topic handle — a session subject rather than the human's
      // canonical display name. Unknown is safer than that false attribution.
      requireCanonicalDisplayName: true,
      onNamed: (trackId) => this.repaintTrack(trackId),
    });
    this.manager = new GmeetCompatibleBuffer({
      ...options.buffer,
      // Teams' wall-clock witness proved that GMeet's confirmed-prefix early-return can otherwise
      // suppress a Whisper-available trailing draft for > 4 seconds. The shared module's default
      // remains faithful; this is a Teams-only visibility adaptation.
      publishTrailingDraftAfterPrefix: true,
      // CSRC routing already opens a new sourceKey when a virtual lane becomes discontinuous.
      // The copied GMeet batch-feeder gap guard would otherwise create a second Whisper trigger
      // directly from feedAudio(), bypassing the one shared two-second window timer.
      flushOnInputGap: false,
      isHallucination: options.buffer?.isHallucination
        // Teams owns this adapter, not the shared GMeet window. A repeated acknowledgement at
        // the head of a growing result must not delete the genuine speech that follows it.
        ?? ((text) => teamsWindowHallucinationRule(text) !== null),
    });
    this.channelizer = new TeamsCsrcChannelizer({
      lookbackMs: options.lookbackMs,
      flickerHoldMs: options.flickerHoldMs,
      onFrame: (frame) => {
        options.onRoutedFrame?.(frame);
        this.recordRoutedSpan(frame.csrc, frame.tsMs, frame.tsMs + frame.pcm.length / 16_000 * 1000);
        this.routeFrame(frame.csrc, frame.pcm, frame.tsMs);
      },
    });

    this.manager.onSegmentReady = (sourceKey, _name, audio, observedTrigger) => {
      const prompt = this.manager.getLastConfirmedText(sourceKey) || undefined;
      const bufferTrigger = observedTrigger ?? 'input-gap';
      const trigger = bufferTrigger === 'interval' || bufferTrigger === 'manual'
        ? 'scheduled'
        : bufferTrigger === 'input-gap'
          ? 'buffer'
          : 'forced';
      const job = (async () => {
        try {
          const csrc = this.sourceToCsrc.get(sourceKey);
          if (csrc === undefined) throw new Error(`unknown CSRC source ${sourceKey}`);
          const context = { csrc, sourceKey, forced: trigger === 'forced', trigger, bufferTrigger } as const;
          // Keep the window through an STT outage: retry with backoff while the lane runs, and back to
          // back during the final pass, which is bounded by finalPassMs.
          let result!: TranscriptionResult;
          for (let attempt = 1; ; attempt++) {
            try { result = await this.options.transcribe(audio, prompt, context); break; }
            catch (error) {
              const pastDeadline = this.disposingAt !== undefined
                && Date.now() - this.disposingAt > (this.options.finalPassMs ?? 120_000);
              if (pastDeadline) throw error;
              this.options.onError?.(error);
              const base = this.options.sttRetryBaseMs ?? 5000, max = this.options.sttRetryMaxMs ?? 60_000;
              const delay = this.disposingAt !== undefined ? Math.min(base, 200) : Math.min(max, base * 2 ** (attempt - 1));
              await new Promise((r) => setTimeout(r, delay));
            }
          }
          this.contestSubmissions.push({
            sourceKey,
            segments: result.segments ?? [],
            observedAtMs: this.sourceLastAudioMs.get(sourceKey),
          });
          const lastEnd = result.segments?.length
            ? result.segments[result.segments.length - 1].end
            : undefined;
          this.manager.handleTranscriptionResult(
            sourceKey,
            (result.text ?? '').trim(),
            lastEnd,
            result.segments,
            result.language,
          );
          this.refreshContestsForSource(sourceKey);
        } catch (error) {
          this.options.onError?.(error);
          // The window is given up (past the final-pass deadline): record WHAT was lost, by capture
          // time, so the meeting carries a gap instead of a silent hole.
          const endMs = this.sourceLastAudioMs.get(sourceKey) ?? Date.now();
          const startMs = endMs - (audio.length / 16_000) * 1000;
          const f = error as { kind?: string; status?: number } | undefined;
          if (endMs > startMs) {
            this.missing.push({
              speakerName: `CSRC ${this.sourceToCsrc.get(sourceKey) ?? sourceKey}`, startMs, endMs,
              reason: `stt refused the window past the final-pass deadline (${f?.kind ?? 'error'}${f?.status ? ` HTTP ${f.status}` : ''})`,
            });
          }
          this.manager.handleTranscriptionResult(sourceKey, '');
        }
      })();
      this.inflight.add(job);
      void job.finally(() => this.inflight.delete(job));
    };

    this.manager.onSegmentConfirmed = (sourceKey, _name, text, startMs, endMs, managerSegmentId, language) => {
      // Match GMeet's public transcript key exactly: confirmed and draft rows both upsert by the
      // first observed draft window. Whisper may move the same forming boundary between passes;
      // that must update one durable row, not persist near-identical rows a few hundred ms apart.
      const draft = this.pendingDrafts.get(sourceKey);
      const segmentId = draft?.segmentId ?? managerSegmentId;
      const publicStartMs = draft?.startMs ?? startMs;
      this.pendingDrafts.delete(sourceKey);
      this.promotedDraftIds.delete(segmentId);
      this.publish(sourceKey, segmentId, text, publicStartMs, endMs, true, language);
    };
    this.manager.onSegmentPending = (sourceKey, _name, text, startMs, language) => {
      const existing = this.pendingDrafts.get(sourceKey);
      const segmentId = existing?.segmentId ?? `${sourceKey}:${Math.round(startMs)}`;
      const publicStartMs = existing?.startMs ?? startMs;
      if (text.trim()) {
        this.pendingDrafts.set(sourceKey, { sourceKey, segmentId, text, startMs: publicStartMs, language });
        // Once the timeout persisted this public row, later forming drafts must not downgrade it
        // back to completed:false. A word-prefix extension may still grow that persisted row as
        // completed:true; a non-prefix Whisper revision waits for real confirmation.
        if (this.promotedDraftIds.has(segmentId)) {
          const previous = this.published.get(segmentId)?.text ?? '';
          if (this.isWordPrefix(previous, text)) {
            this.publish(
              sourceKey,
              segmentId,
              text,
              publicStartMs,
              Math.max(publicStartMs, this.sourceLastAudioMs.get(sourceKey) ?? publicStartMs),
              true,
              language,
            );
          }
        } else {
          this.publish(sourceKey, segmentId, text, publicStartMs, publicStartMs, false, language);
        }
      } else {
        this.pendingDrafts.delete(sourceKey);
        if (!this.promotedDraftIds.has(segmentId)) {
          this.publish(sourceKey, segmentId, '', publicStartMs, publicStartMs, false, language);
        }
      }
    };
  }

  feedMixedAudio(pcm: Float32Array, tsMs: number): void {
    if (!this.transportSeen && Number.isFinite(tsMs)) this.feedNoTransportFallback(pcm, tsMs);
    this.channelizer.feedAudio(pcm, tsMs);
    this.trackNamer.tick(tsMs + pcm.length / 16_000 * 1000);
    this.promoteTimedOutDrafts(tsMs);
  }

  /**
   * Route the mix to one fallback lane while the transport has never reported a contributing
   * source. Naming still works: the fallback track turns active/inactive on speech energy, so the
   * namer can bind Teams' own speaking hints to it exactly as it binds them to a CSRC track; with
   * no corroborated hint it keeps its stable Speaker label (published as unknown).
   */
  private feedNoTransportFallback(pcm: Float32Array, tsMs: number): void {
    if (this.firstAudioMs === undefined) this.firstAudioMs = tsMs;
    const lane = TEAMS_NO_TRANSPORT_LANE;
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
    const frameMs = pcm.length / 16_000 * 1000;
    const energetic = peak > TEAMS_FALLBACK_SILENCE_PEAK;
    if (!this.fallbackActive) {
      // Wait on SPEECH, not on wall time: a working transport reports its first edge within a
      // packet train of the first word, so only speech that arrives with no edge arms the
      // fallback. The waiting speech is held and routed on engagement, so no word is lost to it.
      if (!energetic) return;
      this.fallbackHeld.push({ pcm, tsMs });
      this.fallbackHeldMs += frameMs;
      if (this.fallbackHeldMs < this.noTransportFallbackMs) return;
      this.fallbackActive = true;
      const held = this.fallbackHeld.splice(0);
      this.fallbackHeldMs = 0;
      this.ownership.set(lane, [{ startMs: held[0]?.tsMs ?? tsMs }]);
      this.notifyFallback(true, tsMs);
      for (const frame of held) this.routeFallbackFrame(frame.pcm, frame.tsMs);
      return;
    }
    if (!energetic) {
      if (this.fallbackSpeaking && tsMs - this.fallbackLastEnergyMs > this.onsetGapMs) {
        this.fallbackSpeaking = false;
        this.trackNamer.setTrackActive(String(lane), false, this.fallbackLastEnergyMs);
      }
      return;
    }
    this.routeFallbackFrame(pcm, tsMs);
  }

  private routeFallbackFrame(pcm: Float32Array, tsMs: number): void {
    const lane = TEAMS_NO_TRANSPORT_LANE;
    if (!this.fallbackSpeaking) {
      this.fallbackSpeaking = true;
      this.trackNamer.setTrackActive(String(lane), true, tsMs);
    }
    const endMs = tsMs + pcm.length / 16_000 * 1000;
    this.fallbackLastEnergyMs = endMs;
    this.fallbackFrames++;
    this.recordRoutedSpan(lane, tsMs, endMs);
    this.routeFrame(lane, pcm, tsMs);
  }

  private notifyFallback(engaged: boolean, tMs: number): void {
    try {
      this.options.onNoTransportFallback?.({
        engaged, tMs, waitedMs: Math.max(0, tMs - (this.firstAudioMs ?? tMs)), routedFrames: this.fallbackFrames,
      });
    } catch { /* diagnostics never break the transcript lane */ }
  }

  /** The first transport edge retires the fallback lane for good: CSRC routing owns the meeting
   *  from here, and keeping both would feed every later word to STT twice. */
  private retireNoTransportFallback(tMs: number): void {
    this.transportSeen = true;
    this.fallbackHeld.length = 0;
    this.fallbackHeldMs = 0;
    if (!this.fallbackActive) return;
    this.fallbackActive = false;
    const lane = TEAMS_NO_TRANSPORT_LANE;
    if (this.fallbackSpeaking) {
      this.fallbackSpeaking = false;
      this.trackNamer.setTrackActive(String(lane), false, tMs);
    }
    const open = (this.ownership.get(lane) ?? []).find((interval) => interval.endMs === undefined);
    if (open) open.endMs = tMs;
    const state = this.tracks.get(lane);
    if (state) {
      this.tracks.delete(lane);
      this.closeTurn(state.key);
    }
    this.notifyFallback(false, tMs);
  }

  recordTransportEvent(event: TransportEvent): void {
    if (!this.transportSeen && Number.isFinite(event.csrc) && Number.isFinite(event.tMs)) {
      this.retireNoTransportFallback(event.tMs);
    }
    this.trackNamer.setTrackActive(String(event.csrc), event.active, event.tMs);
    const intervals = this.ownership.get(event.csrc) ?? [];
    if (event.active) {
      if (!intervals.some((interval) => interval.endMs === undefined)) intervals.push({ startMs: event.tMs });
    } else {
      const open = [...intervals].reverse().find((interval) => interval.endMs === undefined);
      if (open) open.endMs = event.tMs;
    }
    this.ownership.set(event.csrc, intervals);
    this.channelizer.recordTransportEvent(event);
  }

  /** Teams' named active-speaker hint. It names a transport track; it never cuts audio. */
  recordHint(name: string, tMs: number, isEnd = false): void {
    this.trackNamer.recordHint(name, tMs, isEnd);
  }

  /** Teams' own caption author is independent name evidence for the active transport track. */
  recordCaption(name: string, tMs: number): void {
    this.trackNamer.recordCaption(name, tMs);
  }

  /** A roster name can canonicalize or complete an already-evidenced transport identity. */
  recordRosterName(name: string, tMs?: number): void {
    this.trackNamer.recordRosterName(name, tMs);
  }

  /** Elimination is allowed only when Teams proved how complete the observed roster was. */
  recordRosterCoverage(named: number, participants: number, tMs?: number): void {
    this.trackNamer.recordRosterCoverage(named, participants, tMs);
  }

  /** Deterministic replay seam; production uses the GMeet-default scheduled two-second cadence. */
  async requestTranscription(csrc: number, force = false): Promise<boolean> {
    const state = this.tracks.get(csrc);
    if (!state) return false;
    const requested = await this.manager.requestTranscription(state.key, force);
    await this.settleInflight();
    return requested;
  }

  activeCsrcs(): number[] {
    return [...this.tracks.keys()];
  }

  health(): TeamsCsrcGmeetPipelineHealth {
    return {
      ...this.channelizer.health(),
      turns: this.turnCount,
      openSources: this.manager.getActiveSpeakers().length,
      inFlight: this.inflight.size,
      rejectedOwnership: this.rejectedOwnership,
      uncontestedOwnership: this.uncontestedOwnership,
      timeoutPromotions: this.timeoutPromotions,
      contestedPairs: this.contests.size,
      noTransportFallback: this.fallbackActive,
      fallbackFrames: this.fallbackFrames,
    };
  }

  async flush(): Promise<void> {
    this.promoteTimedOutDrafts(Number.POSITIVE_INFINITY, true);
    for (const state of this.tracks.values()) await this.flushSource(state.key);
    await this.settleAll();
  }

  /** Set when dispose begins: failed requests retry back to back until the final-pass deadline. */
  private disposingAt: number | undefined;

  /** Every window this lane gave up on, by capture time (epoch ms). */
  missingRanges(): MissingRange[] {
    return this.missing.map((r) => ({ ...r }));
  }

  async dispose(): Promise<void> {
    this.disposingAt = Date.now();
    await this.flush();
    this.trackNamer.finish();
    this.manager.removeAll();
  }

  private routeFrame(csrc: number, pcm: Float32Array, tsMs: number): void {
    let state = this.tracks.get(csrc);
    if (!state || tsMs - state.lastAudioMs > this.onsetGapMs) {
      if (state) this.closeTurn(state.key);
      const turn = (state?.turn ?? 0) + 1;
      const key = `csrc-${csrc}:${turn}`;
      state = { key, turn, lastAudioMs: tsMs };
      this.tracks.set(csrc, state);
      this.sourceToCsrc.set(key, csrc);
      this.turnCount++;
      this.manager.addSpeaker(key, `CSRC ${csrc}`);
    }
    state.lastAudioMs = tsMs;
    this.sourceLastAudioMs.set(state.key, tsMs + pcm.length / 16_000 * 1000);
    this.manager.feedAudio(state.key, pcm, tsMs);
  }

  private closeTurn(sourceKey: string): void {
    const job = (async () => {
      try {
        await this.flushSource(sourceKey);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.releaseTurn(sourceKey);
      }
    })();
    this.closing.add(job);
    void job.finally(() => this.closing.delete(job));
  }

  /**
   * Retire a turn key that will never be fed again. `routeFrame` mints one key per turn and each
   * key opens its own two-second submission timer inside the shared GMeet window, so the manager
   * releases the key here — otherwise a meeting's timers and per-key bookkeeping grow with its
   * turn count for the whole session.
   *
   * Ordered strictly AFTER the flush: `flushSource` submits the turn's remaining audio and settles
   * the transcription it triggers, so the removal below finds an already-drained buffer and the
   * final rows have been published under a live `sourceToCsrc` entry.
   */
  private releaseTurn(sourceKey: string): void {
    this.manager.removeSpeaker(sourceKey);
    this.sourceToCsrc.delete(sourceKey);
    this.sourceLastAudioMs.delete(sourceKey);
    this.pendingDrafts.delete(sourceKey);
    // Both id shapes a turn publishes under (`<sourceKey>:<startMs>` and the manager's
    // `<sourceKey>:<seq>`) carry the key plus a separator, so the prefix cannot reach a sibling
    // turn such as `csrc-201:30` from `csrc-201:3`.
    const prefix = `${sourceKey}:`;
    for (const id of this.promotedDraftIds) {
      if (id.startsWith(prefix)) this.promotedDraftIds.delete(id);
    }
  }

  private async flushSource(sourceKey: string): Promise<void> {
    await this.manager.flushSpeaker(sourceKey, true);
    await this.settleInflight();
  }

  private publish(
    sourceKey: string,
    segmentId: string,
    text: string,
    startMs: number,
    endMs: number,
    completed: boolean,
    language?: string,
  ): boolean {
    const csrc = this.sourceToCsrc.get(sourceKey);
    if (csrc === undefined) return false;
    // Whisper segment ends can overhang the submitted PCM (especially on terminal flush). A public
    // transcript row must never claim audio later than the last sample actually routed to this
    // source. The start is retained; a fully overhanging tail collapses to a zero-length boundary.
    const sourceAudioEndMs = this.sourceLastAudioMs.get(sourceKey);
    const boundedEndMs = sourceAudioEndMs === undefined
      ? endMs
      : Math.max(startMs, Math.min(endMs, sourceAudioEndMs));
    if (completed && text.trim() && !spanFitsCsrcOwnership(
      this.ownership.get(csrc) ?? [],
      startMs,
      boundedEndMs,
      this.ownershipLookbackMs,
      this.ownershipSlackMs,
      this.onsetGapMs,
    )) {
      const segment = { csrc, speaker: this.trackNamer.labelFor(String(csrc)), sourceKey, segmentId, text, startMs, endMs: boundedEndMs, completed, language };
      const intervals = (this.ownership.get(csrc) ?? []).map((interval) => ({ ...interval }));
      // Published under the lane's name only when it is the sole CSRC the meeting has ever reported
      // (an unreported speaker's audio is routed to the last active lane, so with a second lane
      // known the name cannot be trusted), the offset is plausible clock skew, and no other lane
      // was routed audio near the span. Anything else is refused: unknown beats a wrong name.
      const offsetMs = this.ownershipOffsetMs(intervals, startMs);
      if (
        Math.abs(offsetMs) > TEAMS_UNCONTESTED_MAX_OFFSET_MS
        || this.otherLaneKnown(csrc)
        || this.routedToAnotherLane(csrc, startMs, boundedEndMs)
      ) {
        this.rejectedOwnership++;
        this.options.onRejectedOwnership?.(segment, intervals);
        // Clear an ordinary draft under the same public key if the confirmed replacement is refused.
        // A timeout-promoted durable row must survive a refused extension.
        if (!this.promotedDraftIds.has(segmentId)) {
          this.emit({ ...segment, text: '', endMs: startMs, completed: false });
        }
        return false;
      }
      // Every frame of this segment was routed to this lane alone, so no other speaker can own
      // it: the misfit is a disagreement between the capture clock (frame stamps) and the
      // transport clock (CSRC edges), not a second voice. Publish, and report the disagreement.
      this.uncontestedOwnership++;
      try {
        this.options.onUncontestedOwnership?.(segment, offsetMs, intervals);
      } catch { /* diagnostics never break the transcript lane */ }
    }
    this.emit({ csrc, speaker: this.trackNamer.labelFor(String(csrc)), sourceKey, segmentId, text, startMs, endMs: boundedEndMs, completed, language });
    return true;
  }

  /** Has the transport ever reported a CSRC (or the fallback lane run) other than `csrc`? */
  private otherLaneKnown(csrc: number): boolean {
    for (const lane of this.ownership.keys()) if (lane !== csrc) return true;
    return false;
  }

  /** Was audio within TEAMS_COMPETING_LANE_MARGIN_MS of [startMs, endMs] (capture clock) routed to a lane other than `csrc`? */
  private routedToAnotherLane(csrc: number, startMs: number, endMs: number): boolean {
    const margin = TEAMS_COMPETING_LANE_MARGIN_MS;
    return this.routedSpans.some((span) => span.csrc !== csrc && span.startMs <= endMs + margin && span.endMs >= startMs - margin);
  }

  /** How far `startMs` sits before the nearest ownership interval's start (ms; negative: after). */
  private ownershipOffsetMs(intervals: CsrcOwnershipInterval[], startMs: number): number {
    let offset = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const interval of intervals) {
      const distance = Math.abs(interval.startMs - startMs);
      if (distance < best) { best = distance; offset = interval.startMs - startMs; }
    }
    return offset;
  }

  private emit(segment: TeamsCsrcTranscriptSegment): void {
    if (!segment.completed && !segment.text.trim()) {
      this.rawPublished.delete(segment.segmentId);
      this.removeContestsFor(segment.segmentId);
      const previous = this.published.get(segment.segmentId);
      this.published.delete(segment.segmentId);
      this.options.onSegment(previous ? { ...previous, text: '', completed: false } : segment);
      return;
    }
    this.rawPublished.set(segment.segmentId, segment);
    this.refreshContestsFor(segment.segmentId);
    this.reconcilePublished();
  }

  private isWordPrefix(prefixText: string, candidateText: string): boolean {
    const words = (value: string): string[] => value
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const prefix = words(prefixText);
    const candidate = words(candidateText);
    return prefix.length <= candidate.length && prefix.every((word, index) => candidate[index] === word);
  }

  /** A name is accepted only by the existing corroborated Teams namer. Re-emit the same ids so
   * collectors and the live witness perform an ordinary upsert instead of duplicating speech. */
  private repaintTrack(trackId: string): void {
    const csrc = Number(trackId);
    if (!Number.isFinite(csrc)) return;
    const speaker = this.trackNamer.labelFor(trackId);
    for (const segment of this.rawPublished.values()) {
      if (segment.csrc !== csrc || segment.speaker === speaker) continue;
      this.rawPublished.set(segment.segmentId, { ...segment, speaker });
    }
    this.reconcilePublished();
  }

  private recordRoutedSpan(csrc: number, startMs: number, endMs: number): void {
    const previous = this.latestRoutedSpan.get(csrc);
    if (previous && startMs <= previous.endMs + 20) {
      previous.endMs = Math.max(previous.endMs, endMs);
    } else {
      const span = { csrc, startMs, endMs };
      this.routedSpans.push(span);
      this.latestRoutedSpan.set(csrc, span);
    }
    // Word-contest evidence is needed only while a rival timestamp-overlapping row can still
    // arrive. Retain the detected pair count for meeting telemetry, but bound raw word traces and
    // routed spans. Diagnostic notation must never be written into the customer transcript.
    const evidenceFloorMs = endMs - 120_000;
    for (let index = this.routedSpans.length - 1; index >= 0; index--) {
      if (this.routedSpans[index].endMs < evidenceFloorMs) this.routedSpans.splice(index, 1);
    }
    for (let index = this.contestSubmissions.length - 1; index >= 0; index--) {
      if ((this.contestSubmissions[index].observedAtMs ?? endMs) < evidenceFloorMs) {
        this.contestSubmissions.splice(index, 1);
      }
    }
  }

  private contestKey(left: string, right: string): string {
    return [left, right].sort().join('~');
  }

  private removeContestsFor(segmentId: string): void {
    for (const [key, contest] of this.contests) {
      if (contest.leftSegmentId === segmentId || contest.rightSegmentId === segmentId) this.contests.delete(key);
    }
  }

  private refreshContestsFor(segmentId: string): void {
    const row = this.rawPublished.get(segmentId);
    this.removeContestsFor(segmentId);
    if (!row?.completed || !row.text.trim()) return;
    for (const rival of this.rawPublished.values()) {
      if (rival.segmentId === segmentId || !rival.completed || !rival.text.trim()) continue;
      const contest = detectTeamsWordContest(row, rival, this.contestSubmissions, this.routedSpans);
      if (contest) this.contests.set(this.contestKey(row.segmentId, rival.segmentId), contest);
    }
  }

  private refreshContestsForSource(sourceKey: string): void {
    for (const row of this.rawPublished.values()) {
      if (row.sourceKey === sourceKey) this.refreshContestsFor(row.segmentId);
    }
    this.reconcilePublished();
  }

  private reconcilePublished(): void {
    for (const raw of this.rawPublished.values()) {
      // Contest detection is internal abstention/telemetry. Customer transcript text is always
      // Whisper's confirmed text verbatim; implementation diagnostics never enter public rows.
      const desired = raw;
      const previous = this.published.get(raw.segmentId);
      if (previous && previous.text === desired.text && previous.speaker === desired.speaker
          && previous.completed === desired.completed && previous.startMs === desired.startMs
          && previous.endMs === desired.endMs && previous.language === desired.language) continue;
      this.published.set(raw.segmentId, desired);
      this.options.onSegment(desired);
    }
  }

  private promoteTimedOutDrafts(nowMs: number, force = false): void {
    for (const draft of this.pendingDrafts.values()) {
      if (this.promotedDraftIds.has(draft.segmentId)) continue;
      if (!force && nowMs - draft.startMs < this.persistTimeoutMs) continue;
      const endMs = Math.max(draft.startMs, this.sourceLastAudioMs.get(draft.sourceKey) ?? nowMs);
      if (this.publish(
        draft.sourceKey,
        draft.segmentId,
        draft.text,
        draft.startMs,
        endMs,
        true,
        draft.language,
      )) {
        this.promotedDraftIds.add(draft.segmentId);
        this.timeoutPromotions++;
      }
    }
  }

  private async settleInflight(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async settleAll(): Promise<void> {
    while (this.closing.size || this.inflight.size) {
      await Promise.all([...this.closing, ...this.inflight]);
    }
  }
}
