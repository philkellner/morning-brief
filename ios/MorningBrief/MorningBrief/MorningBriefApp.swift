import SwiftUI
import UIKit
import UserNotifications

@main
struct MorningBriefApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = DigestStore()
    @State private var settings = AppSettings.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            StoryListView()
                .environment(store)
                .environment(settings)
                .task { await start() }
                .onChange(of: scenePhase) { _, phase in
                    // Coming back to the foreground is the most reliable moment to
                    // pick up a digest the background task may have missed.
                    if phase == .active {
                        Task { await refreshAndReschedule() }
                    }
                }
        }
    }

    private func start() async {
        store.loadCached()
        NotificationScheduler.shared.registerCategories()

        if await NotificationScheduler.shared.authorizationStatus() == .notDetermined {
            await NotificationScheduler.shared.requestAuthorization()
        }
        await refreshAndReschedule()
        BackgroundRefresh.schedule()
    }

    private func refreshAndReschedule() async {
        await store.refresh()
        if let digest = store.digest {
            await NotificationScheduler.shared.reschedule(with: digest)
        }
    }
}

/// Registers the background task before launch completes and routes notification taps.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// Set when the user taps a notification, so the list can open that story.
    static let openStory = Notification.Name("MorningBrief.openStory")

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BackgroundRefresh.register()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Show the banner even if the app happens to be open at 06:00.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let storyID = response.notification.request.content.userInfo["storyID"] as? String else { return }
        await MainActor.run {
            NotificationCenter.default.post(name: Self.openStory, object: nil, userInfo: ["storyID": storyID])
        }
    }
}
