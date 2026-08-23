import Foundation
import Observation

/// User-tunable behaviour, persisted in UserDefaults.
///
/// The properties are *stored*, not computed over UserDefaults: `@Observable`
/// only tracks stored properties, and a computed wrapper would leave SwiftUI
/// bindings silently failing to update. Each setter writes through to defaults.
@Observable
final class AppSettings {
    static let shared = AppSettings()

    /// raw.githubusercontent.com needs no GitHub Pages setup, so it works the
    /// moment the first digest is committed.
    static let defaultDigestURL =
        "https://raw.githubusercontent.com/philkellner/morning-brief/main/docs/digest.json"

    @ObservationIgnored private let defaults: UserDefaults

    private enum Keys {
        static let hour = "notification.hour"
        static let minute = "notification.minute"
        static let storyLimit = "notification.storyLimit"
        static let spacingSeconds = "notification.spacingSeconds"
        static let digestURL = "digest.url"
        static let notificationsEnabled = "notification.enabled"
        static let soundEveryStory = "notification.soundEveryStory"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Keys.hour: 6,
            Keys.minute: 0,
            Keys.storyLimit: 10,
            Keys.spacingSeconds: 45,
            Keys.digestURL: Self.defaultDigestURL,
            Keys.notificationsEnabled: true,
            Keys.soundEveryStory: false,
        ])

        hour = defaults.integer(forKey: Keys.hour)
        minute = defaults.integer(forKey: Keys.minute)
        storyLimit = defaults.integer(forKey: Keys.storyLimit)
        spacingSeconds = defaults.integer(forKey: Keys.spacingSeconds)
        digestURL = defaults.string(forKey: Keys.digestURL) ?? Self.defaultDigestURL
        notificationsEnabled = defaults.bool(forKey: Keys.notificationsEnabled)
        soundEveryStory = defaults.bool(forKey: Keys.soundEveryStory)
    }

    var hour: Int = 6 {
        didSet {
            hour = min(max(hour, 0), 23)
            defaults.set(hour, forKey: Keys.hour)
        }
    }

    var minute: Int = 0 {
        didSet {
            minute = min(max(minute, 0), 59)
            defaults.set(minute, forKey: Keys.minute)
        }
    }

    /// How many stories become notifications. More than about a dozen in one
    /// burst turns Notification Centre into a wall.
    var storyLimit: Int = 10 {
        didSet {
            storyLimit = min(max(storyLimit, 1), 20)
            defaults.set(storyLimit, forKey: Keys.storyLimit)
        }
    }

    /// Gap between consecutive notifications, so ten arrive as a readable
    /// trickle rather than a single buzzing pile.
    var spacingSeconds: Int = 45 {
        didSet {
            spacingSeconds = min(max(spacingSeconds, 0), 600)
            defaults.set(spacingSeconds, forKey: Keys.spacingSeconds)
        }
    }

    var digestURL: String = AppSettings.defaultDigestURL {
        didSet { defaults.set(digestURL, forKey: Keys.digestURL) }
    }

    var notificationsEnabled: Bool = true {
        didSet { defaults.set(notificationsEnabled, forKey: Keys.notificationsEnabled) }
    }

    /// Ten chimes in seven minutes is a lot. By default only the lead story
    /// makes a sound; the rest arrive quietly.
    var soundEveryStory: Bool = false {
        didSet { defaults.set(soundEveryStory, forKey: Keys.soundEveryStory) }
    }

    var resolvedURL: URL? { URL(string: digestURL.trimmingCharacters(in: .whitespacesAndNewlines)) }

    var deliveryTimeDescription: String { String(format: "%02d:%02d", hour, minute) }
}
