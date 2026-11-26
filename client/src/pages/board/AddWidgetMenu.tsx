/**
 * "Add widget" (plan #198 Part 3a §4.4): a menu button in the Edit toolbar, after Add panel, and in
 * each section's header. It lists the registry's defs by label; choosing one adds a panel with the
 * def's vis and size (`addWidget`), which opens its editor. Disabled while busy.
 */
import { useContext } from 'react';
import { MenuTrigger } from 'react-aria-components';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { Icon } from '../../kit/Icon';
import { Menu, MenuItem } from '../../kit/Menu';
import { Popover } from '../../kit/Popover';
import { WidgetRegistryContext, type WidgetDef } from '../../widgets/registry';

export interface AddWidgetMenuProps {
  /** The trigger's accessible name, which also names the menu. */
  label: string;
  busy: boolean;
  onAdd: (def: WidgetDef) => void;
}

export function AddWidgetMenu({ label, busy, onAdd }: AddWidgetMenuProps) {
  const { defs } = useContext(WidgetRegistryContext);
  return (
    <MenuTrigger>
      <Button aria-label={label} isDisabled={busy || defs.length === 0} data-board-add-widget="">
        <Icon name="plus" />
        {t('board.addWidget')}
      </Button>
      <Popover placement="bottom start">
        {/* MenuTrigger labels this menu by the trigger (aria-labelledby). */}
        <Menu aria-label={label}>
          {defs.map((d) => (
            <MenuItem
              key={d.kind}
              id={d.kind}
              onAction={() => {
                onAdd(d);
              }}
            >
              {t(d.label)}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
