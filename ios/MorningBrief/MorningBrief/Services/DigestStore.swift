import Foundation
import Observation
import OSLog

/// Fetches the digest, caches it on disk, and keeps the UI in step.
@MainActor
@Observable
final class DigestStore {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(Digest)
        case failed(String)
    }

    private(set) var state: LoadState = .idle
    private(set) var lastFetch: Date?

    private let settings: AppSettings
    private let session: URLSession
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "MorningBrief", category: "DigestStore")

    var digest: Digest? {
        if case let .loaded(digest) = state { return digest }
        return nil
    }

    init(settings: AppSettings = .shared, session: URLSession = .shared) {
        self.settings = settings
        self.session = session
    }

    private static var cacheURL: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("digest.json")
    }

    /// Show cached content immediately so the list is never blank on launch.
    func loadCached() {
        guard digest == nil else { return }
        guard let data = try? Data(contentsOf: Self.cacheURL),
              let cached = try? JSONDecoder.digestDecoder.decode(Digest.self, from: data) else { return }
        state = .loaded(cached)
        logger.debug("Loaded cached digest, edition \(cached.edition, privacy: .public)")
    }

    /// Fetch the latest digest. Returns the digest on success so background
    /// refresh can decide whether it is worth rescheduling notifications.
    @discardableResult
    func refresh() async -> Digest? {
        guard let url = settings.resolvedURL else {
            state = .failed("The digest URL in Settings isn't a valid URL.")
            return nil
        }

        if digest == nil { state = .loading }

        var request = URLRequest(url: url)
        // The digest is rewritten daily; a stale CDN copy would silently mean
        // yesterday's notifications.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30

        do {
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])
            }
            let decoded = try JSONDecoder.digestDecoder.decode(Digest.self, from: data)
            state = .loaded(decoded)
            lastFetch = .now
            try? data.write(to: Self.cacheURL, options: .atomic)
            logger.info("Fetched digest edition \(decoded.edition, privacy: .public) with \(decoded.stories.count) stories")
            return decoded
        } catch {
            logger.error("Digest fetch failed: \(error.localizedDescription, privacy: .public)")
            // Keep showing cached content rather than replacing it with an error.
            if digest == nil {
                state = .failed(Self.describe(error))
            }
            return nil
        }
    }

    private static func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet: return "No internet connection."
            case .timedOut: return "The request timed out."
            case .fileDoesNotExist, .badServerResponse:
                return "No digest published yet. The scheduled build runs each morning."
            default: return urlError.localizedDescription
            }
        }
        if error is DecodingError {
            return "The digest file couldn't be read. It may still be being written."
        }
        return error.localizedDescription
    }
}
