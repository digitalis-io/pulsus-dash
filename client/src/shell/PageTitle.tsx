/**
 * The page title shown in the header `<h1>` and in `document.title` ("<title> · Pulsus Dash").
 * Pages call `usePageTitle(title)`; outside the shell only `document.title` is set.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { t } from '../i18n/t';

interface PageTitleState {
  title: string;
  setTitle: (title: string) => void;
}

const PageTitleContext = createContext<PageTitleState | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState('');
  const value = useMemo(() => ({ title, setTitle }), [title]);
  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

export function usePageTitle(title: string): void {
  const setTitle = useContext(PageTitleContext)?.setTitle;
  useEffect(() => {
    setTitle?.(title);
    document.title = t('app.documentTitle', { title });
  }, [setTitle, title]);
}

export function usePageTitleValue(): string {
  return useContext(PageTitleContext)?.title ?? '';
}
