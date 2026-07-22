interface ContentLogLinkProps {
  title?: string | null;
  contentText?: string | null;
  contentUrl?: string | null;
}

/**
 * One content item in the analytics drawer, rendered as a single link.
 *
 * The href may be the originating post (youtube.com/x.com) or an R2-backed processed video
 * produced by a Video Action node — both render identically on purpose: the label always
 * describes the CONTENT, never the URL. An R2 URL's last segment is a bare UUID, so showing it
 * instead of the title would turn a Video Action node's drawer into a column of UUIDs.
 */
export function ContentLogLink({ title, contentText, contentUrl }: ContentLogLinkProps) {
  const label =
    title ||
    (contentText ? `${contentText.slice(0, 5)}…` : null) ||
    // Last resort — the filename, which at least distinguishes rows from one another.
    contentUrl?.split("/").pop() ||
    "(no content)";

  if (!contentUrl) return <p className="text-foreground truncate">{label}</p>;

  return (
    <a
      href={contentUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-primary underline hover:no-underline block truncate"
      title={label}
    >
      {label}
    </a>
  );
}
