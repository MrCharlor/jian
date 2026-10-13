import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * What a page needs now and then, such as its settings, closed under the list it serves: a
 * heading that says what is inside, opened in place.
 */
export function Disclosure({
  title,
  hint,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>
        {icon && (
          <span className="resource-icon tile" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="grow">
          <strong>{title}</strong>
          {hint && <small>{hint}</small>}
        </span>
        <ChevronDown size={16} className="disclosure-chevron" aria-hidden="true" />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
