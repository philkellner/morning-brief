import Foundation
import UserNotifications
import OSLog

/// Turns a digest into one local notification per story.
///
/// Local notifications are used deliberately: they need no push server, no APNs
/// certificate and no paid developer account. The trade-off is that the content
/// must already be on the device when the alarm fires, which is what the
/// background refresh in `BackgroundRefresh` is for.
struct NotificationScheduler {
    static let shared = NotificationScheduler()

    private let center = UNUserNotificationCenter.current()
    private let logger = Logger(subsystem: "com.philkellner.MorningBrief", category: "Notifications")

    static let categoryIdentifier = "MORNING_BRIEF_STORY"
    private static let identifierPrefix = "story."

    // MARK: - Authorization

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            logger.error("Authorization request failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func registerCategories() {
        let category = UNNotificationCategory(
            identifier: Self.categoryIdentifier,
            actions: [],
            intentIdentifiers: [],
            options: [.hiddenPreviewsShowTitle]
        )
        center.setNotificationCategories([category])
    }

    // MARK: - Scheduling

    /// The next occurrence of the configured time, today if it is still ahead of us.
    func nextDelivery(after now: Date = .now, settings: AppSettings = .shared, calendar: Calendar = .current) -> Date? {
        var components = calendar.dateComponents([.year, .month, .day], from: now)
        components.hour = settings.hour
        components.minute = settings.minute
        components.second = 0

        guard let todaysSlot = calendar.date(from: components) else { return nil }
        if todaysSlot > now { return todaysSlot }
        return calendar.date(byAdding: .day, value: 1, to: todaysSlot)
    }

    /// Replace all pending story notifications with ones built from `digest`.
    /// - Returns: the number of notifications scheduled.
    @discardableResult
    func reschedule(
        with digest: Digest,
        settings: AppSettings = .shared,
        now: Date = .now,
        calendar: Calendar = .current
    ) async -> Int {
        await cancelAll()

        guard settings.notificationsEnabled else {
            logger.info("Notifications disabled in settings - nothing scheduled.")
            return 0
        }
        let status = await authorizationStatus()
        guard status == .authorized || status == .provisional else {
            logger.info("Not authorised to post notifications - nothing scheduled.")
            return 0
        }
        guard let base = nextDelivery(after: now, settings: settings, calendar: calendar) else {
            logger.error("Could not compute a delivery date.")
            return 0
        }

        let stories = Array(digest.stories.prefix(settings.storyLimit))
        guard !stories.isEmpty else { return 0 }

        // If the alarm will fire on a day this digest does not cover, say so in the
        // lead notification rather than passing yesterday's news off as today's.
        let deliveryIsCovered = digest.isCurrent(on: base)
        var scheduled = 0

        for (index, story) in stories.enumerated() {
            let fireDate = base.addingTimeInterval(Double(index * settings.spacingSeconds))
            let content = UNMutableNotificationContent()
            content.title = story.title
            content.body = story.summary
            content.categoryIdentifier = Self.categoryIdentifier
            content.threadIdentifier = "morning-brief.\(digest.edition)"
            content.userInfo = ["storyID": story.id, "url": story.url, "edition": digest.edition]
            content.sound = (index == 0 || settings.soundEveryStory) ? .default : nil
            content.interruptionLevel = .active

            var subtitle = "\(story.rank) of \(stories.count) · \(story.provenance)"
            if index == 0 {
                if digest.isSample {
                    subtitle = "Sample data · the first real digest has not been built yet"
                } else if !deliveryIsCovered {
                    subtitle = "Digest from \(digest.edition) · today's build may not have run"
                }
            }
            content.subtitle = subtitle

            // Sorts the burst correctly in Notification Centre.
            content.relevanceScore = Double(stories.count - index) / Double(stories.count)

            let components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireDate)
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            let request = UNNotificationRequest(
                identifier: "\(Self.identifierPrefix)\(digest.edition).\(story.id)",
                content: content,
                trigger: trigger
            )

            do {
                try await center.add(request)
                scheduled += 1
            } catch {
                logger.error("Failed to schedule story \(story.rank): \(error.localizedDescription, privacy: .public)")
            }
        }

        logger.info("Scheduled \(scheduled) notifications starting \(base, privacy: .public)")
        return scheduled
    }

    func cancelAll() async {
        let pending = await center.pendingNotificationRequests()
        let ids = pending.map(\.identifier).filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    func pendingStoryCount() async -> Int {
        await center.pendingNotificationRequests()
            .filter { $0.identifier.hasPrefix(Self.identifierPrefix) }
            .count
    }

    /// Fires in five seconds so you can confirm delivery without waiting for morning.
    func sendTestNotification(using digest: Digest?) async {
        let content = UNMutableNotificationContent()
        content.title = digest?.stories.first?.title ?? "Morning Brief is set up"
        content.body = digest?.stories.first?.summary ?? "This is what a story notification looks like."
        content.subtitle = "Test notification"
        content.sound = .default
        content.categoryIdentifier = Self.categoryIdentifier

        let request = UNNotificationRequest(
            identifier: "test.\(UUID().uuidString)",
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false)
        )
        try? await center.add(request)
    }
}
