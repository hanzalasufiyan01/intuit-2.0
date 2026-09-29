import { useId, useRef, useState, type DragEvent } from 'react';
import { Alert } from './Alert';

/**
 * File picker with drag and drop and upload progress (S5 §13, S5-22). The size and extension
 * checks here are hints only; the server enforces every rule. The caller supplies the upload.
 */
export function FileUpload({
  accept,
  maxBytes,
  label,
  hint,
  upload,
  errorMessage,
}: {
  /** Comma-separated extensions, e.g. ".pdf,.png". */
  accept: string;
  maxBytes: number;
  label: string;
  hint: string;
  upload: (file: File, onProgress: (fraction: number) => void) => Promise<void>;
  errorMessage: (error: unknown) => string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = progress !== null;

  const allowed = accept.split(',').map((e) => e.trim().toLowerCase());
  const hintProblem = (file: File) => {
    const dot = file.name.lastIndexOf('.');
    const extension = dot > 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!allowed.includes(extension)) return 'This file type is not accepted here.';
    if (file.size > maxBytes) return 'The file is larger than 25 MB.';
    return null;
  };

  const start = async (file: File) => {
    const problem = hintProblem(file);
    setError(problem);
    if (problem) return;
    setProgress(0);
    try {
      await upload(file, setProgress);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && !busy) void start(file);
  };

  return (
    <div
      className={dragging ? 'file-upload file-upload--dragging' : 'file-upload'}
      data-testid="file-drop-zone"
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={input}
        type="file"
        accept={accept}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void start(file);
        }}
      />
      <p className="muted">{hint} You can also drop a file here.</p>
      {busy ? (
        <progress aria-label="Upload progress" max={1} value={progress}>
          {Math.round(progress * 100)}%
        </progress>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
