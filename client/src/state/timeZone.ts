import { createContext, useContext } from 'react';
import { browserTimeZone } from '../i18n/format';

/** The IANA zone the Context resolves `now/d` and calendar days in; the browser's by default. */
export const TimeZoneContext = createContext<string>(browserTimeZone());

export function useTimeZone(): string {
  return useContext(TimeZoneContext);
}
