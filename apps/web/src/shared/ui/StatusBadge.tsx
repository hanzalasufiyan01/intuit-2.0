import { useT, type MessageKey, type Translate } from '../../i18n/i18n';
import { Badge, type BadgeTone } from './Badge';

/** One status of a vocabulary: its translated label and its tone, both stated explicitly. */
export interface StatusEntry {
  key: MessageKey;
  tone: BadgeTone;
}

/**
 * A feature's status vocabulary. Declare it `satisfies Record<TheStatusUnion, StatusEntry>` so a status
 * added to the union without a label and a tone fails type-checking.
 */
export type StatusMap = Readonly<Record<string, StatusEntry>>;

/** The translated label of a status for running text. A status the map does not list is shown as it came. */
export function statusText(t: Translate, map: StatusMap, status: string): string {
  const entry = Object.hasOwn(map, status) ? map[status] : undefined;
  return entry ? t(entry.key) : status;
}

/**
 * A status badge driven by a status map. A status the map does not list (one the server added before
 * the UI knew it) is shown as it came in the neutral tone, never as success or danger by accident.
 */
export function MappedStatusBadge({ map, status }: { map: StatusMap; status: string }) {
  const t = useT();
  const entry = Object.hasOwn(map, status) ? map[status] : undefined;
  return <Badge tone={entry?.tone ?? 'neutral'}>{entry ? t(entry.key) : status}</Badge>;
}
