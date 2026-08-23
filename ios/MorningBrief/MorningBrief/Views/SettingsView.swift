import SwiftUI
import UIKit
import UserNotifications

struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(DigestStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @State private var pendingCount = 0
    @State private var deliveryTime = Date()

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            Form {
                Section {
                    DatePicker("Deliver at", selection: $deliveryTime, displayedComponents: .hourAndMinute)
                        .onChange(of: deliveryTime) { _, newValue in
                            let parts = Calendar.current.dateComponents([.hour, .minute], from: newValue)
                            settings.hour = parts.hour ?? 6
                            settings.minute = parts.minute ?? 0
                            Task { await rescheduleAndRefreshStatus() }
                        }

                    Stepper("Stories: \(settings.storyLimit)", value: $settings.storyLimit, in: 1...20)
                        .onChange(of: settings.storyLimit) { _, _ in Task { await rescheduleAndRefreshStatus() } }

                    Stepper("Gap between them: \(settings.spacingSeconds)s", value: $settings.spacingSeconds, in: 0...300, step: 15)
                        .onChange(of: settings.spacingSeconds) { _, _ in Task { await rescheduleAndRefreshStatus() } }

                    Toggle("Sound for every story", isOn: $settings.soundEveryStory)
                        .onChange(of: settings.soundEveryStory) { _, _ in Task { await rescheduleAndRefreshStatus() } }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text(settings.spacingSeconds == 0
                         ? "All \(settings.storyLimit) arrive at once."
                         : "The \(settings.storyLimit) stories arrive over about \(max(0, (settings.storyLimit - 1) * settings.spacingSeconds / 60)) minutes.")
                }

                Section("Status") {
                    LabeledContent("Permission", value: authorizationLabel)
                    LabeledContent("Scheduled", value: "\(pendingCount)")
                    if let next = NotificationScheduler.shared.nextDelivery(settings: settings) {
                        LabeledContent("Next delivery", value: next.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let digest = store.digest {
                        LabeledContent("Edition", value: digest.edition)
                    }

                    if authorizationStatus == .denied {
                        Button("Open iOS Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    } else if authorizationStatus == .notDetermined {
                        Button("Allow notifications") {
                            Task {
                                await NotificationScheduler.shared.requestAuthorization()
                                await rescheduleAndRefreshStatus()
                            }
                        }
                    }

                    Button("Send a test notification") {
                        Task { await NotificationScheduler.shared.sendTestNotification(using: store.digest) }
                    }
                }

                Section {
                    TextField("Digest URL", text: $settings.digestURL, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.footnote.monospaced())
                    Button("Reset to default") { settings.digestURL = AppSettings.defaultDigestURL }
                    Button("Refresh now") { Task { await store.refresh(); await rescheduleAndRefreshStatus() } }
                } header: {
                    Text("Source")
                } footer: {
                    Text("Point this at your own fork to change which outlets are aggregated.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task {
                deliveryTime = Calendar.current.date(
                    bySettingHour: settings.hour, minute: settings.minute, second: 0, of: .now
                ) ?? .now
                await refreshStatus()
            }
        }
    }

    private var authorizationLabel: String {
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral: "Granted"
        case .denied: "Denied"
        case .notDetermined: "Not asked"
        @unknown default: "Unknown"
        }
    }

    private func refreshStatus() async {
        authorizationStatus = await NotificationScheduler.shared.authorizationStatus()
        pendingCount = await NotificationScheduler.shared.pendingStoryCount()
    }

    private func rescheduleAndRefreshStatus() async {
        if let digest = store.digest {
            await NotificationScheduler.shared.reschedule(with: digest)
        }
        BackgroundRefresh.schedule()
        await refreshStatus()
    }
}
