let currentCsrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  currentCsrfToken = token;
}

export function getCsrfToken(): string | null {
  return currentCsrfToken;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, status: number, code = 'API_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<T = any>(
  path: string,
  options: RequestInit & { headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers || {}),
  };

  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (currentCsrfToken) {
    headers['x-csrf-token'] = currentCsrfToken;
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  });

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await res.json() : null;

  if (!res.ok) {
    throw new ApiError(
      data?.error || `Request failed with status ${res.status}`,
      res.status,
      data?.code || 'HTTP_ERROR',
      data?.details
    );
  }

  return data as T;
}

export interface UploadProgressTask {
  promise: Promise<any>;
  abort: () => void;
}

export function uploadFilesWithProgress(params: {
  url: string;
  files: File[];
  folderId?: string | null;
  relativePaths?: string[];
  extraHeaders?: Record<string, string>;
  onProgress?: (loadedBytes: number, totalBytes: number, percent: number) => void;
}): UploadProgressTask {
  const { url, files, folderId, relativePaths, extraHeaders = {}, onProgress } = params;
  const xhr = new XMLHttpRequest();

  const promise = new Promise<any>((resolve, reject) => {
    const formData = new FormData();
    if (folderId) {
      formData.append('folderId', folderId);
    }
    if (relativePaths && relativePaths.length > 0) {
      formData.append('relativePaths', JSON.stringify(relativePaths));
    }
    for (const file of files) {
      formData.append('files', file, file.name);
    }

    xhr.open('POST', url, true);
    xhr.withCredentials = true;

    if (currentCsrfToken) {
      xhr.setRequestHeader('x-csrf-token', currentCsrfToken);
    }
    for (const [k, v] of Object.entries(extraHeaders)) {
      xhr.setRequestHeader(k, v);
    }

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        const pct = Math.min(100, Math.round((evt.loaded / evt.total) * 100));
        onProgress(evt.loaded, evt.total, pct);
      }
    };

    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
      } else {
        reject(
          new ApiError(
            body?.error || `Upload failed (HTTP ${xhr.status})`,
            xhr.status,
            body?.code || 'UPLOAD_ERROR'
          )
        );
      }
    };

    xhr.onerror = () => {
      reject(new ApiError('Network error during file upload', 0, 'NETWORK_ERROR'));
    };

    xhr.onabort = () => {
      reject(new ApiError('Upload cancelled', 499, 'UPLOAD_CANCELLED'));
    };

    xhr.send(formData);
  });

  return {
    promise,
    abort: () => xhr.abort(),
  };
}
