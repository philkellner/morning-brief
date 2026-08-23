import SwiftUI

struct StoryDetailView: View {
    let story: Story
    @Environment(\.openURL) private var openURL

    private var provenanceFootnote: String {
        var text = "Headline chosen as the least sensational phrasing among the outlets below."
        if let summarySource = story.summarySource {
            text += " Summary from \(summarySource)."
        }
        return text
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text(story.title).font(.title3.weight(.semibold))
                    if !story.summary.isEmpty {
                        Text(story.summary).font(.body).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)

                if let link = story.link {
                    Button {
                        openURL(link)
                    } label: {
                        Label("Read at \(story.headlineSource)", systemImage: "safari")
                    }
                }
            } footer: {
                Text(provenanceFootnote)
            }

            Section("Why this ranked \(story.rank)") {
                LabeledContent("Outlets covering it", value: "\(story.sourceCount)")
                LabeledContent("Distinct leans", value: "\(story.leanCount)")
                LabeledContent("Spectrum spread", value: story.leanSpread.formatted(.percent.precision(.fractionLength(0))))
                LabeledContent("Wire services", value: "\(story.wireCount)")
            }

            Section("Who ran it") {
                ForEach(story.coverage) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(item.source).font(.subheadline.weight(.medium))
                            Spacer()
                            Text(Lean(rawValue: item.lean)?.shortLabel ?? item.lean)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.15), in: Capsule())
                        }
                        Text(item.title).font(.footnote).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if let url = item.link { openURL(url) } }
                }
            }
        }
        .navigationTitle("Story \(story.rank)")
        .navigationBarTitleDisplayMode(.inline)
    }
}
