export default function Footer() {
  const currentYear = new Date().getFullYear();
  const appVersion = __APP_VERSION__;

  return (
    <footer className="bg-white border-t border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex flex-col sm:flex-row items-center justify-between space-y-4 sm:space-y-0">
          {/* Left side - @Cloud branding */}
          <div className="flex items-center space-x-3">
            <img
              src="/Cloud-removebg.png"
              alt="@Cloud"
              className="h-8 w-auto object-contain"
            />
            <div className="text-sm text-gray-600">
              <span className="font-semibold text-gray-900">@Cloud</span>
              <span className="ml-2">Events Resource Planning System</span>
            </div>
          </div>

          {/* Right side - Copyright and author info */}
          <div className="flex flex-col sm:flex-row items-center space-y-2 sm:space-y-0 sm:space-x-6 text-sm text-gray-500">
            <div className="flex items-center space-x-1">
              <span>© {currentYear}</span>
              <span className="font-medium text-gray-700">
                Travis Fan @Cloud IT Team
              </span>
            </div>
            <div className="hidden sm:block w-px h-4 bg-gray-300"></div>
            <div className="text-center sm:text-left">
              <span>Built with God's help for managing events</span>
            </div>
          </div>
        </div>

        {/* Additional info row */}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <div className="flex flex-col sm:flex-row items-center justify-between text-xs text-gray-600 space-y-2 sm:space-y-0">
            <div>All rights reserved. Unauthorized access is prohibited.</div>
            <div className="flex items-center space-x-4">
              <span>Version {appVersion}</span>
              <span>•</span>
              <span>Dashboard v2025</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
