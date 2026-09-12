interface AuthInitializationErrorProps {
  message: string;
  onRetry: () => Promise<void>;
}

export default function AuthInitializationError({
  message,
  onRetry,
}: AuthInitializationErrorProps) {
  return (
    <div className="flex min-h-64 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950" role="alert">
        <h1 className="text-lg font-semibold">Unable to verify your session</h1>
        <p className="mt-2 text-sm">{message}</p>
        <button
          type="button"
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          onClick={() => void onRetry()}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
