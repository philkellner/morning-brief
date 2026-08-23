import SwiftUI

struct StoryListView: View {
    @Environment(DigestStore.self) private var store
    @Environment(AppSettings.self) private var settings
    @State private var showingSettings = false
    @State private var selectedStory: Story?

    var body: some View {
        NavigationStack {
            Group {
                switch store.state {
                case .idle, .loading:
                    ProgressView("Loading digest…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("No digest yet", systemImage: "newspaper")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await store.refresh() } }
                    }
                case .loaded(let digest):
                    list(for: digest)
                }
            }
            .navigationTitle("Morning Brief")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .navigationDestination(item: $selectedStory) { StoryDetailView(story: $0) }
            .refreshable {
                await store.refresh()
                if let digest = store.digest {
                    await NotificationScheduler.shared.reschedule(with: digest)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: AppDelegate.openStory)) { note in
                guard let id = note.userInfo?["storyID"] as? String else { return }
                selectedStory = store.digest?.stories.first { $0.id == id }
            }
        }
    }

    @ViewBuilder
    private func list(for digest: Digest) -> some View {
        List {
            if digest.isSample {
                Section {
                    Label(
                        "Sample data — the scheduled build hasn't run yet. These aren't real stories.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
            }

            Section {
                ForEach(digest.stories) { story in
                    Button { selectedStory = story } label: { StoryRow(story: story) }
                        .buttonStyle(.plain)
                }
            } header: {
                Text("\(digest.storyCount) stories · edition \(digest.edition)")
            } footer: {
                Text("Ranked by how many outlets across the spectrum covered each story. Notifications arrive at \(settings.deliveryTimeDescription).")
            }
        }
        .listStyle(.insetGrouped)
    }
}

struct StoryRow: View {
    let story: Story

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(story.rank)")
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, alignment: .trailing)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(story.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)

                if !story.summary.isEmpty {
                    Text(story.summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 6) {
                    LeanBar(coverage: story.coverage)
                    Text(story.provenance)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(story.title). \(story.summary). Covered by \(story.sourceCount) outlets across \(story.leanCount) leans.")
    }
}

/// Five slots, left to right across the spectrum; filled where an outlet ran the story.
struct LeanBar: View {
    let coverage: [Story.Coverage]

    private var present: Set<String> { Set(coverage.map(\.lean)) }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Lean.allCases, id: \.self) { lean in
                RoundedRectangle(cornerRadius: 1)
                    .fill(present.contains(lean.rawValue) ? Color.accentColor : Color.secondary.opacity(0.22))
                    .frame(width: 7, height: 7)
            }
        }
        .accessibilityHidden(true)
    }
}
