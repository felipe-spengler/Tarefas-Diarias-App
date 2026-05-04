import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:4173/');
});

test.describe('App de Rotina Silenciosa', () => {
  
  test('deve renderizar o título e o botão de adicionar', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('Silencioso');
    await expect(page.getByLabel('Adicionar Tarefa')).toBeVisible();
  });

  test('deve criar uma nova rotina', async ({ page }) => {
    // Abrir modal
    await page.getByLabel('Adicionar Tarefa').click();
    
    // Preencher formulário
    await page.getByPlaceholder('Ex: Meditação, Reunião...').fill('Meditação Matinal');
    await page.locator('input[type="time"]').fill('07:00');
    await page.locator('input[type="number"]').fill('10');
    
    // Selecionar dias (Segunda, Quarta, Sexta)
    await page.getByText('S', { exact: true }).first().click(); // Segunda
    await page.getByText('Q', { exact: true }).first().click(); // Quarta
    await page.getByText('S', { exact: true }).last().click();  // Sexta
    
    await page.getByRole('button', { name: 'Criar Tarefa' }).click();
    
    // Verificar se apareceu na lista
    await expect(page.getByText('Meditação Matinal')).toBeVisible();
    await expect(page.getByText('07:00')).toBeVisible();
    await expect(page.getByText('-10m')).toBeVisible();
  });

  test('deve criar um evento único', async ({ page }) => {
    await page.getByLabel('Adicionar Tarefa').click();
    await page.getByRole('button', { name: 'Evento Único' }).click();
    
    await page.getByPlaceholder('Ex: Meditação, Reunião...').fill('Consulta Médica');
    await page.locator('input[type="time"]').fill('14:30');
    await page.locator('input[type="date"]').fill('2026-12-25');
    
    await page.getByRole('button', { name: 'Criar Tarefa' }).click();
    
    await expect(page.getByText('Consulta Médica')).toBeVisible();
    await expect(page.getByText('14:30')).toBeVisible();
  });

  test('deve alternar status ativo/inativo', async ({ page }) => {
    // Criar uma tarefa primeiro
    await page.getByLabel('Adicionar Tarefa').click();
    await page.getByPlaceholder('Ex: Meditação, Reunião...').fill('Teste Toggle');
    await page.getByRole('button', { name: 'Criar Tarefa' }).click();

    const taskItem = page.locator('.glass').filter({ hasText: 'Teste Toggle' });
    const toggleBtn = taskItem.locator('button').first();
    
    // Inicialmente ativa (check icon)
    await expect(taskItem).not.toHaveClass(/opacity-50/);
    
    // Clicar para desativar
    await toggleBtn.click();
    await expect(taskItem).toHaveClass(/opacity-50/);
    
    // Clicar para ativar de novo
    await toggleBtn.click();
    await expect(taskItem).not.toHaveClass(/opacity-50/);
  });

  test('deve persistir dados após recarregar a página', async ({ page }) => {
    await page.getByLabel('Adicionar Tarefa').click();
    await page.getByPlaceholder('Ex: Meditação, Reunião...').fill('Tarefa Persistente');
    await page.getByRole('button', { name: 'Criar Tarefa' }).click();
    
    await page.reload();
    
    await expect(page.getByText('Tarefa Persistente')).toBeVisible();
  });

  test('deve deletar uma tarefa', async ({ page }) => {
    await page.getByLabel('Adicionar Tarefa').click();
    await page.getByPlaceholder('Ex: Meditação, Reunião...').fill('Tarefa para Deletar');
    await page.getByRole('button', { name: 'Criar Tarefa' }).click();
    
    const taskItem = page.locator('.glass').filter({ hasText: 'Tarefa para Deletar' });
    await taskItem.locator('button').last().click(); // Delete icon is usually last
    
    await expect(page.getByText('Tarefa para Deletar')).not.toBeVisible();
  });

});
