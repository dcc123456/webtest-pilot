/**
 * The cancel affordance for a run in progress.
 *
 * Extracted from the Chat tab because of a real complaint: cancel was only rendered
 * on a run card inside the chat transcript, so a user who had switched to the Cases
 * or Scripts tab had no way to stop a run at all. It now also lives in the app
 * header, next to the "N running" badge, which is visible from every tab.
 *
 * The pending state is not cosmetic. Cancellation is cooperative — the run stops at
 * the next check rather than being killed — so without visible feedback a user
 * presses the button repeatedly and concludes it does not work.
 *
 * @module panel/CancelButton
 */

import { useState } from 'react'
import { is } from '../lib/messages'
import { Button, usePending, useToast } from './components'
import type { WorkerApi } from './useWorker'

export function CancelButton({
  runId,
  worker,
  label = '取消',
}: {
  runId: string
  worker: WorkerApi
  label?: string
}) {
  const { pending, run } = usePending()
  const toast = useToast()
  /**
   * Sticky once requested, because the run is still winding down.
   *
   * `pending` covers only the round trip to the worker, which returns immediately —
   * the run itself keeps going for another step. Without this the button would snap
   * back to "取消" while the run is visibly still active, which reads as a no-op.
   */
  const [requested, setRequested] = useState(false)

  return (
    <Button
      small
      variant='danger'
      pending={pending}
      disabled={requested}
      title={
        requested
          ? '已请求取消，正在等当前步骤收尾（不会强杀，避免把被测页面留在中间状态）'
          : '停止这次运行：当前步骤结束后停下，状态记为 cancelled（人为取消，不算失败）'
      }
      onClick={() =>
        void run(async () => {
          try {
            const response = await worker.call({ type: 'cancelRun', runId })
            setRequested(true)
            toast.info(is.message(response) ? response.message : '已请求取消。')
          } catch (error) {
            // The usual cause is a run that finished a moment ago, which is not
            // worth an error toast shaped like a failure.
            toast.info(error instanceof Error ? error.message : '该运行已经结束。')
          }
        })
      }
    >
      {requested ? '正在取消…' : label}
    </Button>
  )
}
