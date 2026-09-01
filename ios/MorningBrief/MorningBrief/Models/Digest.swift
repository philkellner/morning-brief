import Foundation

/// Mirrors the JSON written by `scripts/build-digest.mjs`.
struct Digest: Codable, Sendable, Equatable {
    let version: Int
    let edition: String
    let generatedAt: Date
    let timezone: String
    let storyCount: Int
    let stories: [Story]
    let seed: Bool?
    let feeds: Feeds?

    var isSample: Bool { seed == true }

    /// The edition string is a Chicago-local calendar date, so compare it as such.
    func isCurrent(on date: Date = .now, timeZoneIdentifier: String? = nil) -> Bool {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: timeZoneIdentifier ?? timezone) ?? .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: date) == edition
    }

    struct Feeds: Codable, Sendable, Equatable {
        let attempted: Int
        let succeeded: Int
    }
}

struct Story: Codable, Sendable, Identifiable, Hashable {
    let rank: Int
    let id: String
    // Optional so a digest published before topics existed still decodes.
    let topic: String?
    let topicLabel: String?
    let topicShort: String?
    let title: String
    let summary: String
    let url: String
    let headlineSource: String
    let summarySource: String?
    let publishedAt: Date?
    let sourceCount: Int
    let leanCount: Int
    let leanSpread: Double
    let wireCount: Int
    let score: Double
    let coverage: [Coverage]

    var link: URL? {
        guard !url.isEmpty, let u = URL(string: url), u.scheme == "https" || u.scheme == "http" else { return nil }
        return u
    }

    /// "4 outlets · 3 leans" - the line that justifies the story's position.
    var provenance: String {
        let outlets = "\(sourceCount) outlet\(sourceCount == 1 ? "" : "s")"
        let leans = "\(leanCount) lean\(leanCount == 1 ? "" : "s")"
        return "\(outlets) · \(leans)"
    }

    struct Coverage: Codable, Sendable, Hashable, Identifiable {
        let source: String
        let sourceId: String
        let lean: String
        let title: String
        let url: String

        var id: String { sourceId }
        var link: URL? { URL(string: url) }
    }
}

enum Lean: String, CaseIterable {
    case left = "left"
    case centerLeft = "center-left"
    case center = "center"
    case centerRight = "center-right"
    case right = "right"

    var shortLabel: String {
        switch self {
        case .left: "L"
        case .centerLeft: "CL"
        case .center: "C"
        case .centerRight: "CR"
        case .right: "R"
        }
    }
}

extension JSONDecoder {
    /// The pipeline emits ISO-8601 with fractional seconds; `publishedAt` may be null.
    static var digestDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = withFraction.date(from: raw) ?? plain.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unrecognised date: \(raw)")
            )
        }
        return decoder
    }
}
