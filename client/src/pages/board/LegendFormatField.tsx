/** The panel editor's Legend name field (#204): stub. */
import type { DataPanelSpec } from '../../api/types';
import { TextField } from '../../kit/TextField';

export function LegendFormatField(_p: {
  vis: DataPanelSpec['vis'];
  labels: readonly string[];
  error: string | null;
  readOnly: boolean;
  onVis: (next: DataPanelSpec['vis']) => void;
}) {
  return <TextField label="Legend name" />;
}
