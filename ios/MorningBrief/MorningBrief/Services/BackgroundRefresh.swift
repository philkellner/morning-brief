import Foundation
import BackgroundTasks
import OSLog

/// Keeps the on-device digest fresh so the morning alarm carries today's news.
///
/// iOS decides if and when a `BGAppRefreshTask` actually runs - it is a request,
/// never a guarantee. The app therefore also refreshes whenever it is opened, and
/// notifications carry the digest's edition date so a stale brief announces itself
/// instead of pretending to be current.
enum BackgroundRefresh {
    /// Derived from the bundle identifier rather than hard-coded, and Info.plist
    /// declares it as $(PRODUCT_BUNDLE_IDENTIFIER).refresh. Changing the bundle id
    /// in Xcode - which you must do if Apple reports it as already registered -
    /// therefore keeps the two in step on its own. A mismatch is not a build
    /// error: BGTaskScheduler raises it at launch, on device only.
    static let taskIdentifier = "\(Bundle.main.bundleIdentifier ?? "com.philkellner.MorningBrief").refresh"

    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "MorningBrief", category: "BackgroundRefresh")

    /// Must be called before the app finishes launching.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refreshTask)
        }
    }

    /// Ask iOS to wake us shortly before the delivery time, so the fetch has
    /// landed by the time the notifications fire.
    static func schedule(settings: AppSettings = .shared, calendar: Calendar = .current, now: Date = .now) {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = wakeTime(settings: settings, calendar: calendar, now: now)

        do {
            try BGTaskScheduler.shared.submit(request)
            logger.debug("Background refresh requested for \(request.earliestBeginDate?.description ?? "unspecified", privacy: .public)")
        } catch {
            // Simulators and devices with Background App Refresh disabled throw here.
            logger.error("Could not schedule background refresh: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// 45 minutes before delivery: enough slack for the 05:00 Actions build to
    /// have published, and for iOS to run us late and still be useful.
    static func wakeTime(settings: AppSettings = .shared, calendar: Calendar = .current, now: Date = .now) -> Date {
        guard let delivery = NotificationScheduler.shared.nextDelivery(after: now, settings: settings, calendar: calendar) else {
            return now.addingTimeInterval(6 * 3600)
        }
        let wake = delivery.addingTimeInterval(-45 * 60)
        return wake > now ? wake : now.addingTimeInterval(60)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        // Always queue the next one first; if we crash below, the chain survives.
        schedule()

        let work = Task { @MainActor in
            let store = DigestStore()
            store.loadCached()
            let digest = await store.refresh() ?? store.digest
            guard let digest else { return false }
            let count = await NotificationScheduler.shared.reschedule(with: digest)
            logger.info("Background refresh rescheduled \(count) notifications")
            return count > 0
        }

        task.expirationHandler = { work.cancel() }

        Task {
            let success = await work.value
            task.setTaskCompleted(success: success)
        }
    }
}
