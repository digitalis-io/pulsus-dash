import { isRouteErrorResponse, useRouteError } from 'react-router';
import { isApiError } from '../api/types';
import { ErrorPage } from '../pages/ErrorPage';
import { NotFoundPage } from '../pages/NotFoundPage';

/** Root error boundary: 404 responses show the standalone Not found page; others the error page. */
export function RouteErrorPage() {
  const e = useRouteError();
  if (isRouteErrorResponse(e) && e.status === 404) return <NotFoundPage />;
  return <ErrorPage kind={isApiError(e) ? 'session' : 'generic'} />;
}
