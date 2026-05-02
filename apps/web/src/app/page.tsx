export default function Home() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      <div style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Dejavas</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6 }}>
          Secure action layer for AI sales agents. Identity, scoped permissions,
          approval routing, and audit — across the revenue stack.
        </p>
        <p style={{ marginTop: '1.5rem', fontSize: '0.875rem', opacity: 0.5 }}>
          Dashboard scaffold. Audit log, approval inbox, and agent registry land here.
        </p>
      </div>
    </main>
  );
}
