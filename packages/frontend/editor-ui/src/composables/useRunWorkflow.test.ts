import { setActivePinia } from 'pinia';
import { createTestingPinia } from '@pinia/testing';
import { useRouter } from 'vue-router';
import type router from 'vue-router';
import {
	ExpressionError,
	type IPinData,
	type IRunData,
	type Workflow,
	type IExecuteData,
	type ITaskData,
	NodeConnectionTypes,
	type INodeConnections,
} from 'n8n-workflow';

import { useRunWorkflow } from '@/composables/useRunWorkflow';
import type { IStartRunData, IWorkflowData } from '@/Interface';
import { useWorkflowsStore } from '@/stores/workflows.store';
import { useUIStore } from '@/stores/ui.store';
import { useWorkflowHelpers } from '@/composables/useWorkflowHelpers';
import { useToast } from './useToast';
import { useI18n } from '@/composables/useI18n';
import { captor, mock } from 'vitest-mock-extended';
import { useSettingsStore } from '@/stores/settings.store';
import { usePushConnectionStore } from '@/stores/pushConnection.store';
import { createTestNode } from '@/__tests__/mocks';

vi.mock('@/stores/workflows.store', () => ({
	useWorkflowsStore: vi.fn().mockReturnValue({
		allNodes: [],
		runWorkflow: vi.fn(),
		subWorkflowExecutionError: null,
		getWorkflowRunData: null,
		setWorkflowExecutionData: vi.fn(),
		activeExecutionId: null,
		nodesIssuesExist: false,
		executionWaitingForWebhook: false,
		getCurrentWorkflow: vi.fn().mockReturnValue({ id: '123' }),
		getNodeByName: vi.fn(),
		getExecution: vi.fn(),
		nodeIssuesExit: vi.fn(),
		checkIfNodeHasChatParent: vi.fn(),
		getParametersLastUpdate: vi.fn(),
		getPinnedDataLastUpdate: vi.fn(),
		getPinnedDataLastRemovedAt: vi.fn(),
		incomingConnectionsByNodeName: vi.fn(),
		outgoingConnectionsByNodeName: vi.fn(),
	}),
}));

vi.mock('@/stores/pushConnection.store', () => ({
	usePushConnectionStore: vi.fn().mockReturnValue({
		isConnected: true,
	}),
}));

vi.mock('@/composables/useTelemetry', () => ({
	useTelemetry: vi.fn().mockReturnValue({ track: vi.fn() }),
}));

vi.mock('@/composables/useI18n', () => ({
	useI18n: vi.fn().mockReturnValue({ baseText: vi.fn().mockImplementation((key) => key) }),
}));

vi.mock('@/composables/useExternalHooks', () => ({
	useExternalHooks: vi.fn().mockReturnValue({
		run: vi.fn(),
	}),
}));

vi.mock('@/composables/useToast', () => ({
	useToast: vi.fn().mockReturnValue({
		clearAllStickyNotifications: vi.fn(),
		showMessage: vi.fn(),
		showError: vi.fn(),
	}),
}));

vi.mock('@/composables/useWorkflowHelpers', () => ({
	useWorkflowHelpers: vi.fn().mockReturnValue({
		getCurrentWorkflow: vi.fn(),
		saveCurrentWorkflow: vi.fn(),
		getWorkflowDataToSave: vi.fn(),
		setDocumentTitle: vi.fn(),
		executeData: vi.fn(),
		getNodeTypes: vi.fn().mockReturnValue([]),
	}),
}));

vi.mock('@/composables/useNodeHelpers', () => ({
	useNodeHelpers: vi.fn().mockReturnValue({
		updateNodesExecutionIssues: vi.fn(),
	}),
}));

vi.mock('vue-router', async (importOriginal) => {
	const { RouterLink } = await importOriginal<typeof router>();
	return {
		RouterLink,
		useRouter: vi.fn().mockReturnValue({
			push: vi.fn(),
		}),
		useRoute: vi.fn(),
	};
});

describe('useRunWorkflow({ router })', () => {
	let pushConnectionStore: ReturnType<typeof usePushConnectionStore>;
	let uiStore: ReturnType<typeof useUIStore>;
	let workflowsStore: ReturnType<typeof useWorkflowsStore>;
	let router: ReturnType<typeof useRouter>;
	let workflowHelpers: ReturnType<typeof useWorkflowHelpers>;
	let settingsStore: ReturnType<typeof useSettingsStore>;

	beforeAll(() => {
		const pinia = createTestingPinia({ stubActions: false });

		setActivePinia(pinia);

		pushConnectionStore = usePushConnectionStore();
		uiStore = useUIStore();
		workflowsStore = useWorkflowsStore();
		settingsStore = useSettingsStore();

		router = useRouter();
		workflowHelpers = useWorkflowHelpers({ router });
	});

	beforeEach(() => {
		uiStore.activeActions = [];
		vi.clearAllMocks();
	});

	describe('runWorkflowApi()', () => {
		it('should throw an error if push connection is not active', async () => {
			const { runWorkflowApi } = useRunWorkflow({ router });

			vi.mocked(pushConnectionStore).isConnected = false;

			await expect(runWorkflowApi({} as IStartRunData)).rejects.toThrow(
				'workflowRun.noActiveConnectionToTheServer',
			);
		});

		it('should successfully run a workflow', async () => {
			const { runWorkflowApi } = useRunWorkflow({ router });

			vi.mocked(pushConnectionStore).isConnected = true;

			const mockResponse = { executionId: '123', waitingForWebhook: false };
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockResponse);

			const response = await runWorkflowApi({} as IStartRunData);

			expect(response).toEqual(mockResponse);
			expect(workflowsStore.activeExecutionId).toBe('123');
			expect(workflowsStore.executionWaitingForWebhook).toBe(false);
			expect(uiStore.addActiveAction).toHaveBeenCalledWith('workflowRunning');
		});

		it('should prevent running a webhook-based workflow that has issues', async () => {
			const { runWorkflowApi } = useRunWorkflow({ router });
			vi.mocked(workflowsStore).nodesIssuesExist = true;
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue({
				executionId: '123',
				waitingForWebhook: true,
			});

			await expect(runWorkflowApi({} as IStartRunData)).rejects.toThrow(
				'workflowRun.showError.resolveOutstandingIssues',
			);

			vi.mocked(workflowsStore).nodesIssuesExist = false;
		});

		it('should handle workflow run failure', async () => {
			const { runWorkflowApi } = useRunWorkflow({ router });

			vi.mocked(pushConnectionStore).isConnected = true;
			vi.mocked(workflowsStore).runWorkflow.mockRejectedValue(new Error('Failed to run workflow'));

			await expect(runWorkflowApi({} as IStartRunData)).rejects.toThrow('Failed to run workflow');
			expect(uiStore.removeActiveAction).toHaveBeenCalledWith('workflowRunning');
		});

		it('should set waitingForWebhook if response indicates waiting', async () => {
			const { runWorkflowApi } = useRunWorkflow({ router });

			vi.mocked(pushConnectionStore).isConnected = true;
			const mockResponse = { executionId: '123', waitingForWebhook: true };
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockResponse);

			const response = await runWorkflowApi({} as IStartRunData);

			expect(response).toEqual(mockResponse);
			expect(workflowsStore.executionWaitingForWebhook).toBe(true);
		});
		it('should prevent execution and show error message when workflow is active with single webhook trigger', async () => {
			const pinia = createTestingPinia({ stubActions: false });
			setActivePinia(pinia);
			const toast = useToast();
			const i18n = useI18n();
			const { runWorkflow } = useRunWorkflow({ router });

			vi.mocked(workflowsStore).isWorkflowActive = true;

			vi.mocked(useWorkflowHelpers({ router })).getWorkflowDataToSave.mockResolvedValue({
				nodes: [
					{
						name: 'Slack',
						type: 'n8n-nodes-base.slackTrigger',
						disabled: false,
					},
				],
			} as unknown as IWorkflowData);

			const result = await runWorkflow({});

			expect(result).toBeUndefined();
			expect(toast.showMessage).toHaveBeenCalledWith({
				title: i18n.baseText('workflowRun.showError.deactivate'),
				message: i18n.baseText('workflowRun.showError.productionActive', {
					interpolate: { nodeName: 'Webhook' },
				}),
				type: 'error',
			});
		});

		it('should execute workflow has pin data and is active with single webhook trigger', async () => {
			const pinia = createTestingPinia({ stubActions: false });
			setActivePinia(pinia);
			const toast = useToast();
			const i18n = useI18n();
			const { runWorkflow } = useRunWorkflow({ router });

			vi.mocked(workflowsStore).isWorkflowActive = true;

			vi.mocked(useWorkflowHelpers({ router })).getWorkflowDataToSave.mockResolvedValue({
				nodes: [
					{
						name: 'Slack',
						type: 'n8n-nodes-base.slackTrigger',
						disabled: false,
					},
				],
				pinData: {
					Slack: [{ json: { value: 'data2' } }],
				},
			} as unknown as IWorkflowData);

			const mockExecutionResponse = { executionId: '123' };

			vi.mocked(uiStore).activeActions = [''];
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue({
				name: 'Test Workflow',
			} as unknown as Workflow);
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockExecutionResponse);
			vi.mocked(workflowsStore).nodesIssuesExist = true;
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue({
				id: 'workflowId',
				nodes: [],
			} as unknown as IWorkflowData);
			vi.mocked(workflowsStore).getWorkflowRunData = {
				NodeName: [],
			};

			const result = await runWorkflow({});
			expect(result).toEqual(mockExecutionResponse);

			expect(toast.showMessage).not.toHaveBeenCalledWith({
				title: i18n.baseText('workflowRun.showError.deactivate'),
				message: i18n.baseText('workflowRun.showError.productionActive', {
					interpolate: { nodeName: 'Webhook' },
				}),
				type: 'error',
			});
		});
	});

	describe('runWorkflow()', () => {
		it('should return undefined if UI action "workflowRunning" is active', async () => {
			const { runWorkflow } = useRunWorkflow({ router });
			uiStore.addActiveAction('workflowRunning');
			const result = await runWorkflow({});
			expect(result).toBeUndefined();
		});

		it('should execute workflow even if it has issues', async () => {
			const mockExecutionResponse = { executionId: '123' };
			const { runWorkflow } = useRunWorkflow({ router });

			vi.mocked(uiStore).activeActions = [''];
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue({
				name: 'Test Workflow',
			} as unknown as Workflow);
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockExecutionResponse);
			vi.mocked(workflowsStore).nodesIssuesExist = true;
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue({
				id: 'workflowId',
				nodes: [],
			} as unknown as IWorkflowData);
			vi.mocked(workflowsStore).getWorkflowRunData = {
				NodeName: [],
			};

			const result = await runWorkflow({});
			expect(result).toEqual(mockExecutionResponse);
		});

		it('should execute workflow successfully', async () => {
			const mockExecutionResponse = { executionId: '123' };
			const { runWorkflow } = useRunWorkflow({ router });

			vi.mocked(pushConnectionStore).isConnected = true;
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockExecutionResponse);
			vi.mocked(workflowsStore).nodesIssuesExist = false;
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue({
				name: 'Test Workflow',
			} as Workflow);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue({
				id: 'workflowId',
				nodes: [],
			} as unknown as IWorkflowData);
			vi.mocked(workflowsStore).getWorkflowRunData = {
				NodeName: [],
			};

			const result = await runWorkflow({});
			expect(result).toEqual(mockExecutionResponse);
		});

		it('should send dirty nodes for partial executions v2', async () => {
			vi.mocked(settingsStore).partialExecutionVersion = 2;
			const composable = useRunWorkflow({ router });
			const parentName = 'When clicking';
			const executeName = 'Code';
			vi.mocked(workflowsStore).allNodes = [
				createTestNode({ name: parentName }),
				createTestNode({ name: executeName }),
			];
			vi.mocked(workflowsStore).outgoingConnectionsByNodeName.mockImplementation((nodeName) =>
				nodeName === parentName
					? { main: [[{ node: executeName, type: NodeConnectionTypes.Main, index: 0 }]] }
					: ({} as INodeConnections),
			);
			vi.mocked(workflowsStore).incomingConnectionsByNodeName.mockImplementation((nodeName) =>
				nodeName === executeName
					? { main: [[{ node: parentName, type: NodeConnectionTypes.Main, index: 0 }]] }
					: ({} as INodeConnections),
			);
			vi.mocked(workflowsStore).getWorkflowRunData = {
				[parentName]: [
					{
						startTime: 1,
						executionTime: 0,
						source: [],
					},
				],
				[executeName]: [
					{
						startTime: 1,
						executionTime: 8,
						source: [
							{
								previousNode: parentName,
							},
						],
					},
				],
			};
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue({
				name: 'Test Workflow',
				getParentNodes: () => [parentName],
				nodes: { [parentName]: {} },
			} as unknown as Workflow);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue({
				nodes: [],
			} as unknown as IWorkflowData);
			vi.mocked(workflowHelpers).executeData.mockResolvedValue({
				data: {},
				node: {},
				source: null,
			} as IExecuteData);

			vi.mocked(workflowsStore).checkIfNodeHasChatParent.mockReturnValue(false);
			vi.mocked(workflowsStore).getParametersLastUpdate.mockImplementation((name: string) => {
				if (name === executeName) return 2;
				return undefined;
			});

			const { runWorkflow } = composable;

			await runWorkflow({ destinationNode: 'Code 1', source: 'Node.executeNode' });

			expect(workflowsStore.runWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({ dirtyNodeNames: [executeName] }),
			);
		});

		it('should send triggerToStartFrom if triggerNode and nodeData are passed in', async () => {
			// ARRANGE
			const composable = useRunWorkflow({ router });
			const triggerNode = 'Chat Trigger';
			const nodeData = mock<ITaskData>();
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue(
				mock<Workflow>({ getChildNodes: vi.fn().mockReturnValue([]) }),
			);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue(
				mock<IWorkflowData>({ nodes: [] }),
			);

			const { runWorkflow } = composable;

			// ACT
			await runWorkflow({ triggerNode, nodeData });

			// ASSERT
			expect(workflowsStore.runWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({
					triggerToStartFrom: {
						name: triggerNode,
						data: nodeData,
					},
				}),
			);
		});

		it('should send triggerToStartFrom if triggerNode is passed in without nodeData', async () => {
			// ARRANGE
			const { runWorkflow } = useRunWorkflow({ router });
			const triggerNode = 'Chat Trigger';
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue(
				mock<Workflow>({ getChildNodes: vi.fn().mockReturnValue([]) }),
			);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue(
				mock<IWorkflowData>({ nodes: [] }),
			);

			// ACT
			await runWorkflow({ triggerNode });

			// ASSERT
			expect(workflowsStore.runWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({
					triggerToStartFrom: {
						name: triggerNode,
					},
				}),
			);
		});

		it('does not use the original run data if `partialExecutionVersion` is set to 1', async () => {
			// ARRANGE
			const mockExecutionResponse = { executionId: '123' };
			const mockRunData = { nodeName: [] };
			const { runWorkflow } = useRunWorkflow({ router });
			const dataCaptor = captor();
			const workflow = mock<Workflow>({ name: 'Test Workflow' });
			workflow.getParentNodes.mockReturnValue([]);

			vi.mocked(settingsStore).partialExecutionVersion = 1;
			vi.mocked(pushConnectionStore).isConnected = true;
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockExecutionResponse);
			vi.mocked(workflowsStore).nodesIssuesExist = false;
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue(workflow);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue(
				mock<IWorkflowData>({ id: 'workflowId', nodes: [] }),
			);
			vi.mocked(workflowsStore).getWorkflowRunData = mockRunData;

			// ACT
			const result = await runWorkflow({ destinationNode: 'some node name' });

			// ASSERT
			expect(result).toEqual(mockExecutionResponse);
			expect(workflowsStore.setWorkflowExecutionData).toHaveBeenCalledTimes(1);
			expect(workflowsStore.setWorkflowExecutionData).toHaveBeenCalledWith(dataCaptor);
			expect(dataCaptor.value).toMatchObject({
				data: { resultData: { runData: {} } },
			});
		});

		it('retains the original run data if `partialExecutionVersion` is set to 2', async () => {
			// ARRANGE
			const mockExecutionResponse = { executionId: '123' };
			const mockRunData = { nodeName: [] };
			const { runWorkflow } = useRunWorkflow({ router });
			const dataCaptor = captor();
			const workflow = mock<Workflow>({ name: 'Test Workflow' });
			workflow.getParentNodes.mockReturnValue([]);

			vi.mocked(settingsStore).partialExecutionVersion = 2;
			vi.mocked(pushConnectionStore).isConnected = true;
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockExecutionResponse);
			vi.mocked(workflowsStore).nodesIssuesExist = false;
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue(workflow);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue(
				mock<IWorkflowData>({ id: 'workflowId', nodes: [] }),
			);
			vi.mocked(workflowsStore).getWorkflowRunData = mockRunData;

			// ACT
			const result = await runWorkflow({ destinationNode: 'some node name' });

			// ASSERT
			expect(result).toEqual(mockExecutionResponse);
			expect(workflowsStore.setWorkflowExecutionData).toHaveBeenCalledTimes(1);
			expect(workflowsStore.setWorkflowExecutionData).toHaveBeenCalledWith(dataCaptor);
			expect(dataCaptor.value).toMatchObject({ data: { resultData: { runData: mockRunData } } });
		});

		it("does not send run data if it's not a partial execution even if `partialExecutionVersion` is set to 2", async () => {
			// ARRANGE
			const mockExecutionResponse = { executionId: '123' };
			const mockRunData = { nodeName: [] };
			const { runWorkflow } = useRunWorkflow({ router });
			const dataCaptor = captor();
			const workflow = mock<Workflow>({ name: 'Test Workflow' });
			workflow.getParentNodes.mockReturnValue([]);

			vi.mocked(settingsStore).partialExecutionVersion = 2;
			vi.mocked(pushConnectionStore).isConnected = true;
			vi.mocked(workflowsStore).runWorkflow.mockResolvedValue(mockExecutionResponse);
			vi.mocked(workflowsStore).nodesIssuesExist = false;
			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue(workflow);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue(
				mock<IWorkflowData>({ id: 'workflowId', nodes: [] }),
			);
			vi.mocked(workflowsStore).getWorkflowRunData = mockRunData;

			// ACT
			const result = await runWorkflow({});

			// ASSERT
			expect(result).toEqual(mockExecutionResponse);
			expect(workflowsStore.runWorkflow).toHaveBeenCalledTimes(1);
			expect(workflowsStore.runWorkflow).toHaveBeenCalledWith(dataCaptor);
			expect(dataCaptor.value).toHaveProperty('runData', undefined);
		});
	});

	describe('consolidateRunDataAndStartNodes()', () => {
		it('should return empty runData and startNodeNames if runData is null', () => {
			const { consolidateRunDataAndStartNodes } = useRunWorkflow({ router });
			const workflowMock = {
				getParentNodes: vi.fn(),
				nodes: {},
			} as unknown as Workflow;

			const result = consolidateRunDataAndStartNodes([], null, undefined, workflowMock);
			expect(result).toEqual({ runData: undefined, startNodeNames: [] });
		});

		it('should return correct startNodeNames and newRunData for given directParentNodes and runData', () => {
			const { consolidateRunDataAndStartNodes } = useRunWorkflow({ router });
			const directParentNodes = ['node1', 'node2'];
			const runData = {
				node2: [{ data: { main: [[{ json: { value: 'data2' } }]] } }],
				node3: [{ data: { main: [[{ json: { value: 'data3' } }]] } }],
			} as unknown as IRunData;
			const pinData: IPinData = {
				node2: [{ json: { value: 'data2' } }],
			};
			const workflowMock = {
				getParentNodes: vi.fn().mockImplementation((node) => {
					if (node === 'node1') return ['node3'];
					return [];
				}),
				nodes: {
					node1: { disabled: false },
					node2: { disabled: false },
					node3: { disabled: true },
				},
			} as unknown as Workflow;

			const result = consolidateRunDataAndStartNodes(
				directParentNodes,
				runData,
				pinData,
				workflowMock,
			);

			expect(result.startNodeNames).toContain('node1');
			expect(result.startNodeNames).not.toContain('node3');
			expect(result.runData).toEqual(runData);
		});

		it('should include directParentNode in startNodeNames if it has no runData or pinData', () => {
			const { consolidateRunDataAndStartNodes } = useRunWorkflow({ router });
			const directParentNodes = ['node1'];
			const runData = {
				node2: [
					{
						data: {
							main: [[{ json: { value: 'data2' } }]],
						},
					},
				],
			} as unknown as IRunData;
			const workflowMock = {
				getParentNodes: vi.fn().mockReturnValue([]),
				nodes: { node1: { disabled: false } },
			} as unknown as Workflow;

			const result = consolidateRunDataAndStartNodes(
				directParentNodes,
				runData,
				undefined,
				workflowMock,
			);

			expect(result.startNodeNames).toContain('node1');
			expect(result.runData).toBeUndefined();
		});

		it('should rerun failed parent nodes, adding them to the returned list of start nodes and not adding their result to runData', () => {
			const { consolidateRunDataAndStartNodes } = useRunWorkflow({ router });
			const directParentNodes = ['node1'];
			const runData = {
				node1: [
					{
						error: new ExpressionError('error'),
					},
				],
			} as unknown as IRunData;
			const workflowMock = {
				getParentNodes: vi.fn().mockReturnValue([]),
				nodes: {
					node1: { disabled: false },
					node2: { disabled: false },
				},
			} as unknown as Workflow;

			const result = consolidateRunDataAndStartNodes(
				directParentNodes,
				runData,
				undefined,
				workflowMock,
			);

			expect(result.startNodeNames).toContain('node1');
			expect(result.runData).toEqual(undefined);
		});
	});

	describe('runEntireWorkflow()', () => {
		it('should invoke runWorkflow with expected arguments', async () => {
			const runWorkflowComposable = useRunWorkflow({ router });

			vi.mocked(workflowHelpers).getCurrentWorkflow.mockReturnValue({
				id: 'workflowId',
			} as unknown as Workflow);
			vi.mocked(workflowHelpers).getWorkflowDataToSave.mockResolvedValue({
				id: 'workflowId',
				nodes: [],
			} as unknown as IWorkflowData);

			await runWorkflowComposable.runEntireWorkflow('main', 'foo');

			expect(workflowsStore.runWorkflow).toHaveBeenCalledWith({
				runData: undefined,
				startNodes: [],
				triggerToStartFrom: {
					data: undefined,
					name: 'foo',
				},
				workflowData: {
					id: 'workflowId',
					nodes: [],
				},
			});
		});
	});
});
