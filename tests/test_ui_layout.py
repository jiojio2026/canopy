from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).parents[1]
HTML = (ROOT / "app/static/index.html").read_text(encoding="utf-8")
CSS = (ROOT / "app/static/style.css").read_text(encoding="utf-8")
JS = (ROOT / "app/static/app.js").read_text(encoding="utf-8")


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.tabs = []

    def handle_starttag(self, tag, attrs):
        props = dict(attrs)
        if "id" in props:
            self.ids.append(props["id"])
        if tag == "button" and "tab" in props.get("class", "").split():
            self.tabs.append(props.get("data-tab"))


def test_all_views_and_device_controls_remain_accessible():
    page = PageParser()
    page.feed(HTML)
    assert len(page.ids) == len(set(page.ids)), [
        item for item, count in Counter(page.ids).items() if count > 1
    ]
    assert page.tabs == ["dashboard", "messages", "trace", "advanced", "lin"]
    required = (
        "deviceBadge", "openDeviceBtn", "closeDeviceBtn",
        "deviceInfo", "deviceAction", "channelCards", "metrics",
        "messageForm", "messageRows", "nodeActions", "msgData", "msgKind",
        "traceMode", "traceRows", "traceVisibleCount",
        "filterJson", "queueJson", "propPath", "propResult",
        "linChannel", "linSubJson", "linPubJson", "configDialog",
        "canConfigCards", "linConfigCards", "pageName",
        "signalContextMenu", "signalLibraryDialog", "signalEditorDialog",
        "signalLibraryRows", "signalEditorForm", "signalBitMap",
        "signalPreview", "signalInspectorRows", "signalCanId",
        "signalSearch", "signalInspectorCount",
        "signalImportFile", "signalImportConflict", "signalImportResult",
        "signalDisplayMode", "signalChoices", "signalChoicesGroup",
        "signalOccupiedSummary", "signalExistingList",
        "traceFilterId", "traceFilterChannel", "traceFilterDirection",
        "traceDensity", "traceColumnPicker", "traceColumnOptions",
        "traceResetLayout", "traceTable", "traceTableViewport",
        "traceColgroup", "traceHeaderRow", "traceFilterStats",
        "signalInspectorViewport",
    )
    assert set(required) <= set(page.ids)


def test_sidebar_responsiveness_and_trace_bound():
    for token in (".app-shell", ".sidebar", ".main-nav", ".trace-toolbar",
                  ".trace-actions", ".trace.table-wrap",
                  "@media(max-width: 950px)", "@media(max-width: 650px)"):
        assert token in CSS
    assert "TRACE_RENDER_LIMIT = 1000" in JS
    assert "TRACE_SCROLL_LIMIT = 3000" in JS
    assert 'id="traceVisibleCount"' in HTML


def test_version_alignment():
    assert "v0.5.3" in HTML
    assert "/static/style.css?v=0.5.3" in HTML
    assert "/static/app.js?v=0.5.3" in HTML


def test_signal_editor_actions_and_menu_exist():
    for token in ("openSignalLibrary()", "newSignalFromContext()",
                  'id="signalByteOrder"', 'id="signalBitLength"',
                  'id="signalStartBit"', 'id="signalValueType"',
                  'id="signalFactor"', 'id="signalOffset"'):
        assert token in HTML
    for token in ("function initializeSignalUI()", "function startSignalEditor(",
                  "function saveSignalDefinition(", "function decodedSignalSummary(",
                  "function updateSignalBitMap("):
        assert token in JS


def test_expanded_signal_layout_and_search():
    for token in (".trace-details-table-wrap", ".trace-expand-button",
                  ".signal-inspector-controls", "max-height: 352px"):
        assert token in CSS
    assert "data-trace-collapse" in JS
    assert "function toggleTraceSignalDetails(" in JS
    assert 'id="signalSearch"' in HTML



def test_enum_import_and_occupied_map_controls():
    for token in ('id="signalImportFile"', 'id="signalDisplayMode"',
                  'id="signalChoices"', 'id="signalExistingList"',
                  'id="signalOccupiedSummary"', 'id="signalChoicesHelp"'):
        assert token in HTML
    for token in ("function importSignalLibraryFile(", "function parseChoiceLines(",
                  "function occupiedSignalBits(", "function updateSignalDisplayMode("):
        assert token in JS
    for token in (".signal-byte-bit.is-defined", ".signal-byte-bit.is-overlap",
                  ".signal-existing-chip", ".signal-choice-group"):
        assert token in CSS


def test_dense_trace_workbench_and_configurable_columns():
    for token in ('id="traceDensity"', 'id="traceColumnPicker"',
                  'id="traceHeaderRow"', 'id="traceColgroup"',
                  'id="traceFilterId"', 'id="traceFilterChannel"',
                  'id="traceFilterDirection"',
                  'class="signal-inspector-table"'):
        assert token in HTML
    for token in ("function loadTraceLayout()", "function persistTraceLayout()",
                  "function moveTraceColumn(", "function setTraceColumnVisible(",
                  "function filteredSortedTraceFrames(", "function changeTraceSort(",
                  "function initTraceLayoutControls(", "function renderTraceHeader("):
        assert token in JS
    for token in ("#trace .trace-data-table", "#trace .trace-column-resizer",
                  "#trace.trace-compact", "#trace.trace-standard",
                  "#trace .signal-inspector-table"):
        assert token in CSS


def test_inspector_docks_below_trace_packets():
    assert HTML.index('id="traceTableViewport"') < HTML.index('id="signalInspector"')
    assert "#trace .trace-card:has(#signalInspector:not([hidden]))" in CSS


def test_trace_uses_screen_space_and_custom_can_waveform_brand():
    assert 'href="/static/canopy-mark.svg"' in HTML
    assert 'src="/static/canopy-mark.svg"' in HTML
    assert 'id="navToggleBtn"' in HTML
    assert 'id="tracePaneDivider"' in HTML
    assert '<option value="scroll" selected>' in HTML
    assert 'function updateTraceNavigation()' in JS
    assert 'function initTraceInspectorDivider()' in JS
    assert 'function setTraceInspectorHeight(' in JS
    assert '.app-shell.nav-collapsed' in CSS
    assert '#trace .trace-pane-divider' in CSS
    assert 'flex: 1 1 auto; min-height: 180px; max-height: none' in CSS
    assert 'height: 27px; padding-block: 2px' in CSS


def test_live_plot_is_opt_in_and_reuses_signal_decoder():
    for token in ('id="plotToggleBtn"', 'id="tracePlot"', 'id="plotCanvas"',
                  'id="plotSignalSelect"', 'id="plotWindow"', 'id="plotStatus"',
                  'id="plotLegend"'):
        assert token in HTML
    assert '/static/plot.js?v=0.5.3' in HTML
    assert HTML.index('/static/plot.js?v=0.5.3') < HTML.index('/static/app.js?v=0.5.3')
    for token in ('function toggleSignalPlot()', 'function hideSignalPlot()',
                  'globalThis.CanopyPlot?.ingest(frames)',
                  'globalThis.CanopyPlot?.setDefinitions(signalDefinitions)',
                  'globalThis.CanopyPlot?.clear()'):
        assert token in JS
    for token in ('#trace .trace-plot', '#trace .trace-plot-canvas-wrap',
                  '#trace #plotCanvas', '#trace .signal-inspector-name .trace-plot-inline-add'):
        assert token in CSS


def test_overview_uses_compact_status_and_channel_matrix():
    assert 'class="overview-heading"' in HTML
    assert 'class="overview-summary-grid"' in HTML
    assert 'id="deviceInfo" class="kv overview-device-kv"' in HTML
    assert 'id="channelCards" class="overview-channel-wrap"' in HTML
    assert 'class="grid two overview-grid"' not in HTML
    for token in ("function bitrateLabel(", "function renderChannels()",
                  "function hideChannelDiagnosis(", "function renderMetrics(",
                  "async function diagnose("):
        assert token in JS
    for token in ("#dashboard .overview-summary-grid", "#dashboard .overview-channel-table",
                  "#dashboard .overview-channel-row", "#dashboard .overview-device-kv",
                  "#dashboard .overview-bus-stat", "#dashboard .overview-diagnostic-row[hidden]"):
        assert token in CSS
    assert "根据已接收报文估算" in HTML
