"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat text-[15px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // Charts the data tools saved. Only files served by this app are shown.
          img: ({ src, alt }) =>
            typeof src === "string" && src.startsWith("/api/artifacts/file/") ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local SVG file, not an optimisable image
              <img src={src} alt={alt ?? ""} className="my-2 w-full max-w-[560px] rounded-xl bg-white" />
            ) : (
              <span className="text-faint">[image: {alt}]</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

