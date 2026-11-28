/**
 * The ST render worker (plan #68 C2d2 §1, §3.2; T03 §9.2): the single-thread engine
 * (`virtual:dash-engine-st`) on its own memory, no pool, input by batches (`engine_input_batch`), on
 * the shared logic of `renderCore.ts`.
 */
import init, {
  engine_on_wake,
  engine_start,
  engine_tick,
  engine_wants_frame,
  frame_create,
  frame_data_begin,
  frame_data_clear,
  frame_data_end,
  frame_data_series,
  frame_dispose,
  frame_set_events,
  frame_set_fit,
  frame_crossfade,
  frame_set_selection,
  frame_set_spec,
  frame_set_theme,
  engine_input_batch,
} from 'virtual:dash-engine-st';
import { runRender, type ProbeExports } from './renderCore';

runRender({
  mode: 'st',
  init,
  engine_on_wake,
  engine_start,
  engine_tick,
  engine_wants_frame,
  frame_create,
  frame_data_begin,
  frame_data_clear,
  frame_data_end,
  frame_data_series,
  frame_dispose,
  frame_set_events,
  frame_set_fit,
  frame_crossfade,
  frame_set_selection,
  frame_set_spec,
  frame_set_theme,
  engine_input_batch,
  probe: async () => (await import('virtual:dash-engine-st')) as unknown as ProbeExports,
});
