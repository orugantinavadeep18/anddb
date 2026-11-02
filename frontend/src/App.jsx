import { useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap, MarkerType } from 'reactflow'
import 'reactflow/dist/style.css'

const API = 'http://127.0.0.1:8000'
const initialConnection = { host: 'localhost', port: '1521', service_name: 'FREEPDB1', username: 'HR', password: '', schema: 'HR' }

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`)
  return data
}

function nodeKey(type, name) {
  return `${type}:${name}`
}

function tableLabel(table, highlighted, compact) {
  return <div className={`diagram-node table-node${highlighted ? ' highlighted' : ''}`}>
    <strong>{table.name}</strong>
    {!compact && <div className="diagram-columns">{table.columns.slice(0, 8).map((column) => <span key={column.name}>{column.name} <em>{column.data_type}</em></span>)}{table.columns.length > 8 && <small>+{table.columns.length - 8} more columns</small>}</div>}
  </div>
}

function objectLabel(name, type, highlighted) {
  return <div className={`diagram-node object-node${highlighted ? ' highlighted' : ''}`}><strong>{name}</strong><small>{type}</small></div>
}

function buildGraph(schema, mode, highlightNames, compact, selectedId, impactItems = [], targetObject = '') {
  const highlighted = new Set(highlightNames.map((name) => name.toUpperCase()))
  const tables = schema?.tables || []
  const constraints = schema?.constraints || []
  const views = schema?.views || []
  const dependencies = schema?.dependencies || []
  const nodes = []
  const edges = []

  if (mode === 'schema' || mode === 'impact') {
    tables.forEach((table, index) => {
      const column = index % 3
      const row = Math.floor(index / 3)
      const id = nodeKey('TABLE', table.name)
      nodes.push({ id, searchName: table.name, position: { x: column * 310, y: row * 210 }, data: { label: tableLabel(table, highlighted.has(table.name) || selectedId === id, compact) }, className: highlighted.size && !highlighted.has(table.name) ? 'diagram-muted' : '' })
    })
    constraints.filter((constraint) => constraint.type === 'R' && constraint.references).forEach((constraint, index) => {
      const [targetTable, targetColumn] = constraint.references.split('.')
      const source = nodeKey('TABLE', constraint.table_name)
      const target = nodeKey('TABLE', targetTable)
      if (nodes.some((node) => node.id === source) && nodes.some((node) => node.id === target)) {
        edges.push({ id: `fk-${index}-${source}-${target}`, source, target, label: `${constraint.columns.join(', ')} → ${targetColumn || ''}`, markerEnd: { type: MarkerType.ArrowClosed }, className: highlighted.size && (!highlighted.has(constraint.table_name) && !highlighted.has(targetTable)) ? 'diagram-edge-muted' : '' })
      }
    })
    if (mode === 'impact') {
      impactItems.forEach((item, index) => {
        const id = nodeKey(item.object_type, item.object)
        if (!nodes.some((node) => node.id === id)) {
          nodes.push({ id, searchName: item.object, position: { x: 620, y: index * 120 }, data: { label: objectLabel(item.object, item.object_type, true) } })
        }
        const source = nodeKey('TABLE', targetObject)
        if (nodes.some((node) => node.id === source) && source !== id) {
          edges.push({ id: `impact-${index}-${source}-${id}`, source, target: id, label: item.severity, markerEnd: { type: MarkerType.ArrowClosed }, className: 'impact-edge' })
        }
      })
    }
  }

  if (mode === 'dependencies') {
    const objects = new Map()
    tables.forEach((table) => objects.set(nodeKey('TABLE', table.name), { name: table.name, type: 'TABLE' }))
    views.forEach((view) => objects.set(nodeKey('VIEW', view.name), { name: view.name, type: 'VIEW' }))
    dependencies.forEach((dependency) => {
      objects.set(nodeKey(dependency.type, dependency.name), { name: dependency.name, type: dependency.type })
      objects.set(nodeKey(dependency.referenced_type, dependency.referenced_name), { name: dependency.referenced_name, type: dependency.referenced_type })
    })
    Array.from(objects.values()).forEach((object, index) => {
      const column = index % 3
      const row = Math.floor(index / 3)
      const id = nodeKey(object.type, object.name)
      nodes.push({ id, searchName: object.name, position: { x: column * 300, y: row * 170 }, data: { label: objectLabel(object.name, object.type, highlighted.has(object.name) || selectedId === id) }, className: highlighted.size && !highlighted.has(object.name) ? 'diagram-muted' : '' })
    })
    dependencies.forEach((dependency, index) => {
      const source = nodeKey(dependency.type, dependency.name)
      const target = nodeKey(dependency.referenced_type, dependency.referenced_name)
      if (nodes.some((node) => node.id === source) && nodes.some((node) => node.id === target)) {
        edges.push({ id: `dependency-${index}-${source}-${target}`, source, target, markerEnd: { type: MarkerType.ArrowClosed }, className: highlighted.size && (!highlighted.has(dependency.name) && !highlighted.has(dependency.referenced_name)) ? 'diagram-edge-muted' : '' })
      }
    })
  }

  return { nodes, edges }
}

function DatabaseDiagram({ schema, mode = 'schema', highlightNames = [], compact = false, impactItems = [], targetObject = '' }) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const diagramRef = useRef(null)
  const graph = useMemo(() => buildGraph(schema, mode, highlightNames, compact, selectedId, impactItems, targetObject), [schema, mode, highlightNames, compact, selectedId, impactItems, targetObject])
  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === diagramRef.current)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])
  const focusIds = useMemo(() => {
    if (mode !== 'impact') return null
    const targetId = nodeKey('TABLE', targetObject)
    const ids = new Set([targetId])
    graph.nodes.filter((node) => highlightNames.some((name) => name.toUpperCase() === node.searchName.toUpperCase())).forEach((node) => ids.add(node.id))
    graph.edges.forEach((edge) => { if (edge.source === targetId || edge.target === targetId) { ids.add(edge.source); ids.add(edge.target) } })
    return ids
  }, [graph.edges, graph.nodes, highlightNames, mode, targetObject])
  const visibleNames = useMemo(() => new Set(graph.nodes.filter((node) => (!focusIds || focusIds.has(node.id)) && (!search || node.searchName.toLowerCase().includes(search.toLowerCase()))).map((node) => node.id)), [focusIds, graph.nodes, search])
  const nodes = graph.nodes.map((node) => {
    let className = node.className || ''
    if (mode === 'impact') {
      if (node.id === nodeKey('TABLE', targetObject)) className = 'impact-target'
      else if (highlightNames.some((name) => name.toUpperCase() === node.searchName.toUpperCase())) className = 'impact-affected'
      else if (focusIds?.has(node.id)) className = 'impact-related'
    }
    return { ...node, className, hidden: !visibleNames.has(node.id) }
  })
  const edges = graph.edges.map((edge) => ({ ...edge, hidden: !visibleNames.has(edge.source) || !visibleNames.has(edge.target) }))
  const toggleFullscreen = async () => {
    if (!diagramRef.current) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await diagramRef.current.requestFullscreen()
  }

  return <div className={`diagram-shell${fullscreen ? ' is-fullscreen' : ''}`} ref={diagramRef}>
    <div className="diagram-toolbar">
      <input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tables or objects..." />
      <div className="diagram-actions"><span className="subtle">{nodes.filter((node) => !node.hidden).length} objects · {edges.filter((edge) => !edge.hidden).length} relationships</span><button type="button" className="button secondary diagram-fullscreen" onClick={toggleFullscreen}>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button></div>
    </div>
    <div className="diagram-canvas"><ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_, node) => setSelectedId(node.id)} minZoom={0.25} maxZoom={1.8} attributionPosition="bottom-left"><MiniMap pannable zoomable /><Controls /><Background gap={24} size={1} /></ReactFlow></div>
    {mode === 'impact' && <div className="diagram-legend"><span><i className="legend-dot changed" /> Proposed change</span><span><i className="legend-dot affected" /> Affected object</span><span><i className="legend-dot related" /> Related table</span></div>}
    <p className="diagram-note">Relationships show metadata only. Table rows and sensitive values are never loaded into the diagram.</p>
  </div>
}

function App() {
  const [connection, setConnection] = useState(initialConnection)
  const [connected, setConnected] = useState(false)
  const [schema, setSchema] = useState(null)
  const [active, setActive] = useState('overview')
  const [selectedTable, setSelectedTable] = useState('')
  const [history, setHistory] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [selectedHistory, setSelectedHistory] = useState(null)
  const [sql, setSql] = useState('SELECT * FROM EMPLOYEES FETCH FIRST 20 ROWS ONLY')
  const [queryResult, setQueryResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [change, setChange] = useState({ object_name: '', change_type: 'DROP_COLUMN', column_name: '', constraint_name: '', new_data_type: 'VARCHAR2(100)' })

  const tables = schema?.tables || []
  const currentTable = tables.find((table) => table.name === selectedTable) || tables[0]
  const constraints = useMemo(() => (schema?.constraints || []).filter((item) => item.table_name === (currentTable?.name || selectedTable)), [schema, currentTable, selectedTable])

  useEffect(() => {
    request('/api/history').then((data) => setHistory(data.items || [])).catch(() => {})
  }, [])

  function updateConnection(key, value) {
    setConnection((old) => ({ ...old, [key]: value }))
  }

  async function connectOracle(event) {
    event.preventDefault()
    setLoading(true); setError(''); setNotice('')
    try {
      const data = await request('/api/oracle/connect', { method: 'POST', body: JSON.stringify({ ...connection, port: Number(connection.port) }) })
      setSchema(data.schema); setConnected(true)
      setSelectedTable(data.schema.tables?.[0]?.name || '')
      setChange((old) => ({ ...old, object_name: data.schema.tables?.[0]?.name || '' }))
      setNotice(`Connected to Oracle as ${data.username}.`)
      setActive('overview')
    } catch (err) { setConnected(false); setSchema(null); setError(err.message) }
    finally { setLoading(false) }
  }

  async function refreshSchema() {
    setLoading(true); setError(''); setNotice('')
    try {
      const data = await request('/api/oracle/refresh', { method: 'POST', body: '{}' })
      setSchema(data); setNotice('Schema refreshed from Oracle.')
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function runSql(event) {
    event.preventDefault(); setLoading(true); setError(''); setNotice(''); setQueryResult(null)
    const statement = (sql.trim().match(/^([a-z]+)/i)?.[1] || '').toUpperCase()
    const isDml = ['INSERT', 'UPDATE', 'DELETE'].includes(statement)
    if (isDml && !window.confirm(`${statement} changes data in your Oracle database. Execute and COMMIT this statement?`)) {
      setLoading(false); return
    }
    try {
      const data = await request('/api/oracle/query', { method: 'POST', body: JSON.stringify({ sql, confirm_changes: isDml }) })
      setQueryResult(data)
      if (isDml) {
        setNotice(data.message)
        const refreshed = await request('/api/oracle/refresh', { method: 'POST', body: '{}' })
        setSchema(refreshed)
        loadHistory()
      }
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function analyze(event) {
    event.preventDefault(); setLoading(true); setError(''); setNotice(''); setAnalysis(null)
    try {
      const data = await request('/api/analyze', { method: 'POST', body: JSON.stringify({ ...change, column_name: change.column_name || null, constraint_name: change.constraint_name || null, new_data_type: change.new_data_type || null }) })
      setAnalysis(data); setNotice('Impact report saved to history.'); loadHistory()
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  async function loadHistory() {
    try { const data = await request('/api/history'); setHistory(data.items || []) } catch (err) { setError(err.message) }
  }

  async function deleteHistory(id) {
    try { await request(`/api/history/${id}`, { method: 'DELETE' }); setHistory((old) => old.filter((item) => item.id !== id)); if (selectedHistory?.id === id) setSelectedHistory(null) }
    catch (err) { setError(err.message) }
  }

  function chooseTable(name) {
    setSelectedTable(name)
    setChange((old) => ({ ...old, object_name: name, column_name: '', constraint_name: '' }))
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#overview" onClick={() => setActive('overview')}><span className="brand-icon">A</span><span>AnyDB</span><span className="oracle-tag">ORACLE ONLY</span></a>
        <div className="connection-status"><span className={connected ? 'status-dot on' : 'status-dot'} />{connected ? `Connected · ${schema?.owner || connection.username}` : 'Not connected'}</div>
      </header>

      <main className="page">
        <section className="page-intro"><div><p className="eyebrow">DATABASE WORKSPACE</p><h1>Manage your Oracle database.</h1><p className="subtitle">Explore schema, run SQL, review change risks, and keep a short history of analyses.</p></div></section>

        {error && <div className="message error"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {notice && <div className="message success"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

        <section className="connection panel">
          <div className="section-heading"><div><p className="eyebrow">01 / CONNECTION</p><h2>Oracle connection</h2></div><span className="subtle">Credentials stay in backend memory only</span></div>
          <form onSubmit={connectOracle} className="connection-form">
            <label>Host<input value={connection.host} onChange={(e) => updateConnection('host', e.target.value)} required /></label>
            <label>Port<input type="number" min="1" max="65535" value={connection.port} onChange={(e) => updateConnection('port', e.target.value)} required /></label>
            <label>Service name<input value={connection.service_name} onChange={(e) => updateConnection('service_name', e.target.value)} required /></label>
            <label>Username<input value={connection.username} onChange={(e) => updateConnection('username', e.target.value)} required /></label>
            <label>Password<input type="password" value={connection.password} onChange={(e) => updateConnection('password', e.target.value)} required autoComplete="current-password" /></label>
            <label>Schema display name<input value={connection.schema} onChange={(e) => updateConnection('schema', e.target.value)} placeholder="Same as username" /></label>
            <div className="connect-actions"><button className="button primary" disabled={loading}>{loading ? 'Working…' : connected ? 'Reconnect' : 'Connect to Oracle'}</button>{connected && <button className="button secondary" type="button" onClick={refreshSchema} disabled={loading}>Refresh schema</button>}</div>
          </form>
        </section>

        <nav className="tabs" aria-label="Workspace sections">
          {[['overview', 'Schema'], ['diagrams', 'Diagrams'], ['sql', 'SQL workspace'], ['impact', 'Impact analysis'], ['history', `History${history.length ? ` (${history.length})` : ''}`]].map(([key, label]) => <button key={key} className={active === key ? 'tab active' : 'tab'} onClick={() => setActive(key)}>{label}</button>)}
        </nav>

        {!connected && <div className="empty-connect panel"><div className="empty-symbol">↳</div><h3>Connect to your Oracle database to begin</h3><p>For your local Docker setup, the usual values are localhost, port 1521, and service FREEPDB1.</p></div>}

        {connected && active === 'overview' && <section className="workspace-grid">
          <aside className="panel object-panel"><div className="section-heading"><div><p className="eyebrow">OBJECTS</p><h2>Tables <span className="count">{tables.length}</span></h2></div></div>
            <input className="search-input" placeholder="Filter tables…" onChange={(e) => { const value = e.target.value.toUpperCase(); document.querySelectorAll('[data-table-name]').forEach((el) => { el.hidden = !el.dataset.tableName.includes(value) }) }} />
            <div className="table-list">{tables.map((table) => <button hidden={false} data-table-name={table.name} key={table.name} onClick={() => chooseTable(table.name)} className={currentTable?.name === table.name ? 'table-item selected' : 'table-item'}><span className="table-glyph">▦</span><span>{table.name}</span><small>{table.columns.length}</small></button>)}</div>
            {!tables.length && <p className="subtle">No tables visible to this Oracle user.</p>}
          </aside>
          <section className="panel details-panel"><div className="section-heading"><div><p className="eyebrow">SCHEMA DETAILS</p><h2>{currentTable?.name || 'Select a table'}</h2></div><span className="count">{currentTable?.columns.length || 0} columns</span></div>
            {currentTable && <><div className="table-scroll"><table><thead><tr><th>Column</th><th>Data type</th><th>Nullable</th></tr></thead><tbody>{currentTable.columns.map((col) => <tr key={col.name}><td className="mono strong">{col.name}</td><td className="mono">{col.data_type}</td><td><span className={col.nullable === 'N' ? 'badge no' : 'badge'}>{col.nullable === 'N' ? 'NOT NULL' : 'YES'}</span></td></tr>)}</tbody></table></div>
            <div className="constraint-section"><div className="section-heading compact"><h3>Constraints</h3><span className="count">{constraints.length}</span></div>{constraints.length ? constraints.map((item) => <div className="constraint-item" key={item.name}><span className="constraint-type">{{ P: 'PK', R: 'FK', U: 'UNIQUE', C: 'CHECK' }[item.type] || item.type}</span><div><strong>{item.name}</strong><small>{item.columns.join(', ')}{item.references ? ` → ${item.references}` : ''}</small></div></div>) : <p className="subtle">No constraints found for this table.</p>}</div></>}
          </section>
        </section>}

        {connected && active === 'diagrams' && <section className="diagram-page">
          <section className="panel"><div className="section-heading"><div><p className="eyebrow">SCHEMA MAP</p><h2>Schema-wide overview</h2></div><span className="subtle">All visible tables and foreign keys</span></div><DatabaseDiagram schema={schema} /></section>
          <section className="panel"><div className="section-heading"><div><p className="eyebrow">OBJECT GRAPH</p><h2>Dependency diagram</h2></div><span className="subtle">Tables, views, and dependent objects</span></div><DatabaseDiagram schema={schema} mode="dependencies" /></section>
        </section>}

        {connected && active === 'sql' && <section className="panel sql-panel"><div className="section-heading"><div><p className="eyebrow">02 / QUERY</p><h2>SQL workspace</h2></div><span className="subtle">SELECT · INSERT · UPDATE · DELETE</span></div>
          <form onSubmit={runSql}><label className="field-label" htmlFor="sql-editor">SQL statement</label><textarea id="sql-editor" className="sql-editor" value={sql} onChange={(e) => setSql(e.target.value)} spellCheck="false" />
            <div className="sql-footer"><p>SELECT results are limited to 200 rows. DML statements require confirmation and are committed immediately. DDL and PL/SQL are disabled.</p><button className="button primary" disabled={loading}>{loading ? 'Running…' : 'Run SQL'}</button></div></form>
          {queryResult && <div className="query-result"><div className="result-heading"><h3>Result</h3><span>{queryResult.statement} · {queryResult.row_count ?? queryResult.rows_affected} {queryResult.statement === 'SELECT' ? 'rows' : 'rows affected'}</span></div>{queryResult.columns ? <div className="table-scroll"><table><thead><tr>{queryResult.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{queryResult.rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value === null ? <span className="null-value">NULL</span> : String(value)}</td>)}</tr>)}</tbody></table>{queryResult.truncated && <p className="subtle">Showing first {queryResult.max_rows} rows only.</p>}</div> : <p className="success-text">{queryResult.message}</p>}</div>}
        </section>}

        {connected && active === 'impact' && <section className="impact-grid"><section className="panel"><div className="section-heading"><div><p className="eyebrow">03 / SAFETY</p><h2>Change impact analysis</h2></div></div><p className="section-description">Estimate dependencies before a proposed schema change. AnyDB analyzes metadata only; it will not execute the DDL.</p>
          <form className="impact-form" onSubmit={analyze}><label>Change type<select value={change.change_type} onChange={(e) => setChange((old) => ({ ...old, change_type: e.target.value }))}><option value="DROP_COLUMN">Drop a column</option><option value="MODIFY_DATATYPE">Modify a datatype</option><option value="DROP_CONSTRAINT">Drop a constraint</option></select></label>
            <label>Table<select value={change.object_name} onChange={(e) => setChange((old) => ({ ...old, object_name: e.target.value, column_name: '', constraint_name: '' }))} required>{tables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}</select></label>
            {change.change_type !== 'DROP_CONSTRAINT' && <label>Column<select value={change.column_name} onChange={(e) => setChange((old) => ({ ...old, column_name: e.target.value }))} required><option value="">Select column</option>{(tables.find((table) => table.name === change.object_name)?.columns || []).map((col) => <option key={col.name} value={col.name}>{col.name} · {col.data_type}</option>)}</select></label>}
            {change.change_type === 'DROP_CONSTRAINT' && <label>Constraint<select value={change.constraint_name} onChange={(e) => setChange((old) => ({ ...old, constraint_name: e.target.value }))} required><option value="">Select constraint</option>{(schema?.constraints || []).filter((item) => item.table_name === change.object_name).map((item) => <option key={item.name} value={item.name}>{item.name} · {({ P: 'Primary key', R: 'Foreign key', U: 'Unique', C: 'Check' })[item.type] || item.type}</option>)}</select></label>}
            {change.change_type === 'MODIFY_DATATYPE' && <label>Proposed datatype<input value={change.new_data_type} onChange={(e) => setChange((old) => ({ ...old, new_data_type: e.target.value }))} placeholder="e.g. VARCHAR2(100)" required /></label>}
            <button className="button primary" disabled={loading || !tables.length}>{loading ? 'Analyzing…' : 'Analyze impact'}</button>
          </form></section>
          <section className="panel report-panel">{analysis ? <><div className="section-heading"><div><p className="eyebrow">ANALYSIS REPORT</p><h2>{analysis.target.object}{analysis.target.column ? `.${analysis.target.column}` : ''}</h2></div><span className={`risk risk-${analysis.risk.toLowerCase()}`}>{analysis.risk} RISK</span></div><p className="section-description">{analysis.impact_count} potential impact{analysis.impact_count === 1 ? '' : 's'} found. Report #{analysis.history_id} saved.</p>
            {analysis.impacts.length ? analysis.impacts.map((item, i) => <div className="impact-item" key={`${item.object}-${i}`}><div><strong>{item.object}</strong><small>{item.object_type} · {item.severity}</small></div><p>{item.reason}</p><small className="evidence">Evidence: {item.evidence}</small></div>) : <div className="no-impacts"><strong>No direct impacts detected in visible metadata.</strong><p>This does not prove the change is safe. Check external code and dynamic SQL.</p></div>}
            <div className="report-notes"><h3>Recommended checks</h3><ul>{analysis.recommended_tests.map((item) => <li key={item}>{item}</li>)}</ul><h3>Limitations</h3><ul>{analysis.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
            <div className="impact-visual"><div className="section-heading compact"><div><p className="eyebrow">VIRTUAL IMPACT MAP</p><h3>Affected dependencies</h3></div><span className="subtle">Only the changed table and its connected objects are shown</span></div><DatabaseDiagram schema={schema} mode="impact" compact={false} highlightNames={[analysis.target.object, ...analysis.impacts.map((item) => item.object)]} impactItems={analysis.impacts} targetObject={analysis.target.object} /></div>
          </> : <div className="report-empty"><div className="empty-symbol">◎</div><h3>Your report will appear here</h3><p>Choose a proposed change and analyze it to see potential dependencies and risk.</p></div>}</section></section>}

        {connected && active === 'history' && <section className="panel history-panel"><div className="section-heading"><div><p className="eyebrow">04 / RECORDS</p><h2>Analysis history</h2><p className="section-description">Impact reports and data-changing SQL activity metadata are stored locally. Records older than 7 days are automatically deleted.</p></div><button className="button secondary" onClick={loadHistory}>Refresh</button></div>
          {!history.length ? <div className="report-empty"><h3>No history yet</h3><p>Run an impact analysis to save your first report.</p></div> : <div className="history-list">{history.map((item) => <article className="history-item" key={item.id}><button className="history-main" onClick={() => setSelectedHistory(selectedHistory?.id === item.id ? null : item)}><span className="history-date">{new Date(item.created_at).toLocaleString()}</span><strong>{item.title}</strong><span className="history-target">{item.target}</span><span className={`risk risk-${item.risk.toLowerCase()}`}>{item.risk}</span><span className="history-count">{item.impact_count} impacts</span></button><button className="delete-button" title="Delete history item" onClick={() => deleteHistory(item.id)}>Delete</button>{selectedHistory?.id === item.id && <div className="history-detail"><pre>{JSON.stringify(item.details, null, 2)}</pre></div>}</article>)}</div>}
          <p className="retention-note">Automatic retention: 7 days · Maximum 200 recent records shown · Delete individual records any time.</p>
        </section>}

        <footer><span>AnyDB · Oracle database workspace</span><span>Local-first · No paid API required</span></footer>
      </main>
    </div>
  )
}

export default App
