/**
 * DEV-ONLY Sensory dashboard.
 *
 * A read-only view of the Membrane "sensory system" outputs that live in the
 * SIBLING solidity repo (tools/sensory/): the code graph (graph.db) and the
 * hypothesis run ledgers (hypothesis/runs/*.jsonl). See pages/api/sensory/[resource].ts.
 *
 * - Read-only: this page (and its API) NEVER trigger a sensory run, and never
 *   write to the solidity repo. Refresh only re-reads on-disk artifacts.
 * - Dev-only: the backing API returns 404 in production (NODE_ENV === 'production').
 * - Point elsewhere: set MEMBRANE_SOLIDITY_ROOT (defaults to a sibling checkout
 *   at /Users/EBmic/membrane-solidity) before starting `npm run dev`.
 *
 * Directly reachable at /sensory — intentionally NOT linked from app nav.
 * Self-contained: no new deps, no shared components, no existing file touched.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Badge,
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Code,
  Flex,
  Heading,
  HStack,
  SimpleGrid,
  Spinner,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VStack,
} from '@chakra-ui/react'
import PageSeo from '@/components/PageSeo'

// ---------------------------------------------------------------------------
// types (mirror pages/api/sensory/[resource].ts response shapes)
// ---------------------------------------------------------------------------

type StatusResp = {
  error?: string
  git_head?: string | null
  git_head_short?: string | null
  generated_at?: string | null
  solc?: string | null
  dirty?: boolean
  repo_head_short?: string | null
  stale?: boolean | null
  counts?: { symbols: number; edges: number; hypothesisRunFiles: number }
  sourceRoot?: string
}

type Hotspot = {
  qualified: string
  file: string
  kind: string
  start_line: number
  hotspot: number
  blast_radius: number
  pagerank: number
  churn_90d: number
  complexity: number
}
type HotspotsResp = { error?: string; hotspots?: Hotspot[] }

type HypRow = {
  target: string
  suite: string
  pass: boolean | null
  reproducible: boolean | null
  attributed: string | null
  severity: string | null
  delta: string | null
  pending: string | null
  basis: string | null
  observed: string | null
  predict: string | null
  ts: string | null
}
type Suite = {
  suite: string
  file: string
  generatedAt: string | null
  counts: { pass: number; fail: number; pending: number; total: number }
  rows: HypRow[]
}
type HypothesesResp = {
  error?: string
  suites?: Suite[]
  totals?: { pass: number; fail: number; pending: number }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hypStatus(r: HypRow): 'pass' | 'fail' | 'pending' {
  if (r.pass === true) return 'pass'
  if (r.pass === false) return 'fail'
  return 'pending'
}

const STATUS_COLOR = { pass: 'green', fail: 'red', pending: 'orange' } as const

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '-'
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  return (await res.json()) as T
}

// A neutral, non-throwing async data hook so a missing/unreadable artifact
// renders a clean error banner rather than a crash.
function useResource<T>(url: string, bump: number) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setFetchError(null)
    fetchJson<T>(url)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((e) => {
        if (alive) setFetchError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [url, bump])
  return { data, loading, fetchError }
}

// ---------------------------------------------------------------------------
// error / empty banner
// ---------------------------------------------------------------------------

function ErrorBanner({ message }: { message: string }) {
  return (
    <Box borderWidth="1px" borderColor="orange.400" bg="blackAlpha.300" borderRadius="md" p={4}>
      <Text color="orange.300" fontWeight="bold" mb={1}>
        Artifact unavailable
      </Text>
      <Text fontSize="sm" color="whiteAlpha.800">
        {message}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function StatusBar({ bump }: { bump: number }) {
  const { data, loading, fetchError } = useResource<StatusResp>('/api/sensory/status', bump)
  if (loading) return <Spinner />
  if (fetchError) return <ErrorBanner message={fetchError} />
  if (!data || data.error) return <ErrorBanner message={data?.error ?? 'no status'} />

  const staleBadge =
    data.stale == null ? (
      <Badge colorScheme="gray">HEAD unknown</Badge>
    ) : data.stale ? (
      <Badge colorScheme="red">STALE</Badge>
    ) : (
      <Badge colorScheme="green">FRESH</Badge>
    )

  return (
    <Card variant="outline">
      <CardBody>
        <Flex justify="space-between" align="center" wrap="wrap" gap={4}>
          <HStack spacing={6} wrap="wrap">
            <Stat>
              <StatLabel>Graph HEAD</StatLabel>
              <StatNumber fontSize="lg">
                <Code>{data.git_head_short ?? '—'}</Code>
              </StatNumber>
              <StatHelpText mb={0}>
                repo <Code>{data.repo_head_short ?? '—'}</Code>
                {data.dirty ? ' · dirty' : ''}
              </StatHelpText>
            </Stat>
            <Stat>
              <StatLabel>Generated</StatLabel>
              <StatNumber fontSize="md">
                {data.generated_at ? new Date(data.generated_at).toLocaleString() : '—'}
              </StatNumber>
              <StatHelpText mb={0}>solc {data.solc ?? '—'}</StatHelpText>
            </Stat>
            <Stat>
              <StatLabel>Symbols</StatLabel>
              <StatNumber>{fmt(data.counts?.symbols ?? 0)}</StatNumber>
            </Stat>
            <Stat>
              <StatLabel>Edges</StatLabel>
              <StatNumber>{fmt(data.counts?.edges ?? 0)}</StatNumber>
            </Stat>
            <Stat>
              <StatLabel>Hypothesis suites</StatLabel>
              <StatNumber>{fmt(data.counts?.hypothesisRunFiles ?? 0)}</StatNumber>
            </Stat>
          </HStack>
          <VStack align="flex-end" spacing={1}>
            {staleBadge}
            <Text fontSize="xs" color="whiteAlpha.600">
              {data.sourceRoot}
            </Text>
          </VStack>
        </Flex>
      </CardBody>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

function TallyBadges({ counts }: { counts: Suite['counts'] }) {
  return (
    <HStack spacing={2}>
      <Badge colorScheme="green">{counts.pass} pass</Badge>
      <Badge colorScheme="red">{counts.fail} fail</Badge>
      <Badge colorScheme="orange">{counts.pending} pending</Badge>
      <Badge colorScheme="gray">{counts.total} total</Badge>
    </HStack>
  )
}

function HypRowDetail({ r }: { r: HypRow }) {
  const s = hypStatus(r)
  // The actionable payload: for a fail it's the failing predicate (delta) plus a
  // reproducible flag; for pending it's the pending reason; basis/severity render
  // when a record carries them.
  const actionable = s === 'fail' ? r.delta : s === 'pending' ? r.pending : null
  return (
    <Tr>
      <Td>
        <Badge colorScheme={STATUS_COLOR[s]}>{s}</Badge>
        {s === 'fail' && r.reproducible === true && (
          <Badge ml={1} colorScheme="red" variant="outline">
            reproducible
          </Badge>
        )}
        {s === 'fail' && r.reproducible === false && (
          <Badge ml={1} colorScheme="yellow" variant="outline">
            flaky
          </Badge>
        )}
      </Td>
      <Td>
        <Text fontWeight="semibold">{r.target}</Text>
        {r.predict && (
          <Text fontSize="xs" color="whiteAlpha.600" mt={1} maxW="46ch">
            {r.predict}
          </Text>
        )}
      </Td>
      <Td>{r.severity ? <Badge colorScheme="purple">{r.severity}</Badge> : '—'}</Td>
      <Td>
        {actionable ? (
          <Code
            whiteSpace="pre-wrap"
            fontSize="xs"
            display="block"
            maxW="60ch"
            colorScheme={s === 'fail' ? 'red' : 'orange'}
          >
            {actionable}
          </Code>
        ) : (
          <Text fontSize="xs" color="whiteAlpha.600">
            {r.observed ?? '—'}
          </Text>
        )}
        {r.basis && (
          <Text fontSize="xs" color="cyan.300" mt={1}>
            basis: {r.basis}
          </Text>
        )}
      </Td>
    </Tr>
  )
}

function HypothesesSection({ bump }: { bump: number }) {
  const { data, loading, fetchError } = useResource<HypothesesResp>(
    '/api/sensory/hypotheses',
    bump,
  )
  if (loading) return <Spinner />
  if (fetchError) return <ErrorBanner message={fetchError} />
  if (!data || data.error) return <ErrorBanner message={data?.error ?? 'no hypotheses'} />
  const suites = data.suites ?? []
  if (suites.length === 0)
    return <ErrorBanner message="No hypothesis runs yet — run a suite in tools/sensory/hypothesis." />

  return (
    <VStack align="stretch" spacing={4}>
      <HStack>
        <Heading size="sm">Totals</Heading>
        <Badge colorScheme="green">{data.totals?.pass ?? 0} pass</Badge>
        <Badge colorScheme="red">{data.totals?.fail ?? 0} fail</Badge>
        <Badge colorScheme="orange">{data.totals?.pending ?? 0} pending</Badge>
      </HStack>
      <Accordion allowMultiple defaultIndex={suites.map((_, i) => i)}>
        {suites.map((suite) => (
          <AccordionItem key={suite.suite} borderWidth="1px" borderRadius="md" mb={3}>
            <AccordionButton _expanded={{ bg: 'blackAlpha.400' }}>
              <Flex flex="1" justify="space-between" align="center" wrap="wrap" gap={2} pr={2}>
                <HStack>
                  <Heading size="sm">{suite.suite}</Heading>
                  {suite.counts.fail > 0 && <Badge colorScheme="red">needs attention</Badge>}
                </HStack>
                <HStack spacing={3}>
                  <TallyBadges counts={suite.counts} />
                  <Text fontSize="xs" color="whiteAlpha.600">
                    {suite.generatedAt ? new Date(suite.generatedAt).toLocaleString() : ''}
                  </Text>
                </HStack>
              </Flex>
              <AccordionIcon />
            </AccordionButton>
            <AccordionPanel pb={4}>
              <TableContainer>
                <Table size="sm" variant="simple">
                  <Thead>
                    <Tr>
                      <Th>status</Th>
                      <Th>target / prediction</Th>
                      <Th>severity</Th>
                      <Th>failing predicate · pending reason · basis</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {suite.rows.map((r, i) => (
                      <HypRowDetail key={`${r.target}-${i}`} r={r} />
                    ))}
                  </Tbody>
                </Table>
              </TableContainer>
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
    </VStack>
  )
}

// ---------------------------------------------------------------------------
// Hotspots
// ---------------------------------------------------------------------------

function HotspotsSection({ bump }: { bump: number }) {
  const { data, loading, fetchError } = useResource<HotspotsResp>('/api/sensory/hotspots', bump)
  if (loading) return <Spinner />
  if (fetchError) return <ErrorBanner message={fetchError} />
  if (!data || data.error) return <ErrorBanner message={data?.error ?? 'no hotspots'} />
  const rows = data.hotspots ?? []
  if (rows.length === 0) return <ErrorBanner message="No salience rows in graph.db." />

  return (
    <TableContainer>
      <Table size="sm" variant="simple">
        <Thead>
          <Tr>
            <Th>symbol</Th>
            <Th>file</Th>
            <Th isNumeric>hotspot</Th>
            <Th isNumeric>blast radius</Th>
            <Th isNumeric>churn 90d</Th>
            <Th isNumeric>pagerank</Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((h, i) => (
            <Tr key={`${h.qualified}-${i}`}>
              <Td>
                <Code fontSize="xs">{h.qualified}</Code>
              </Td>
              <Td>
                <Text fontSize="xs" color="whiteAlpha.700">
                  {h.file}:{h.start_line}
                </Text>
              </Td>
              <Td isNumeric fontWeight="bold">
                {fmt(h.hotspot, 1)}
              </Td>
              <Td isNumeric>{fmt(h.blast_radius)}</Td>
              <Td isNumeric>{fmt(h.churn_90d)}</Td>
              <Td isNumeric>{h.pagerank?.toExponential?.(2) ?? '—'}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </TableContainer>
  )
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function SensoryDashboard() {
  const [bump, setBump] = useState(0)
  const refresh = useCallback(() => setBump((b) => b + 1), [])

  return (
    <Box maxW="1200px" mx="auto" px={6} py={8}>
      {/* Rule 0 (docs/SEO_RULESET.md): internal — dev-only sensory system dashboard */}
      <PageSeo
        seoClass="internal"
        title="Membrane — Sensory (Dev)"
        description="Dev-only, read-only view of the Membrane sensory system: code graph hotspots and hypothesis run results from the sibling solidity repo. Never triggers a run."
      />
      <Flex justify="space-between" align="center" mb={2} wrap="wrap" gap={3}>
        <Box>
          <Heading size="lg">Sensory</Heading>
          <Text color="whiteAlpha.600" fontSize="sm">
            Read-only dev view of the Membrane sensory system (code graph + hypothesis harness).
            Never triggers a run.
          </Text>
        </Box>
        <Button size="sm" onClick={refresh}>
          Refresh
        </Button>
      </Flex>

      <VStack align="stretch" spacing={8} mt={4}>
        <StatusBar bump={bump} />

        <Box>
          <Heading size="md" mb={3}>
            Hypotheses
          </Heading>
          <Text color="whiteAlpha.600" fontSize="sm" mb={3}>
            Adversarial + behavioral results — latest run per suite. Failing and pending
            hypotheses surface first with their failing predicate / pending reason.
          </Text>
          <HypothesesSection bump={bump} />
        </Box>

        <Box>
          <Heading size="md" mb={3}>
            Hotspots
          </Heading>
          <Text color="whiteAlpha.600" fontSize="sm" mb={3}>
            Where risk concentrates in the code graph — top 25 by hotspot score (churn ×
            complexity), with incoming blast radius.
          </Text>
          <SimpleGrid columns={1}>
            <HotspotsSection bump={bump} />
          </SimpleGrid>
        </Box>
      </VStack>
    </Box>
  )
}
