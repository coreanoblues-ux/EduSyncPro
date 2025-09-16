import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  Building2, 
  Users, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Shield,
  Crown,
  TrendingUp,
  UserCheck,
  UserX,
  Trash2,
  Ban,
  Play
} from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Tenant {
  id: string;
  accountNumber: string;
  name: string;
  ownerName: string;
  ownerPhone: string;
  status: 'pending' | 'active' | 'expired' | 'suspended';
  createdAt: string;
}

interface TenantStats {
  total: number;
  pending: number;
  active: number;
  expired: number;
  suspended: number;
}

export default function SystemAdmin() {
  const { toast } = useToast();

  // 테넌트 목록 조회
  const { data: tenants = [], isLoading: tenantsLoading } = useQuery<Tenant[]>({
    queryKey: ['/api/superadmin/tenants']
  });

  // 테넌트 통계 계산
  const stats: TenantStats = {
    total: tenants.length,
    pending: tenants.filter(t => t.status === 'pending').length,
    active: tenants.filter(t => t.status === 'active').length,
    expired: tenants.filter(t => t.status === 'expired').length,
    suspended: tenants.filter(t => t.status === 'suspended').length
  };

  // 테넌트 승인/거부 뮤테이션
  const updateTenantMutation = useMutation({
    mutationFn: async ({ tenantId, status }: { tenantId: string; status: string }) => {
      const response = await fetch(`/api/superadmin/tenants/${tenantId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ status })
      });
      
      if (!response.ok) {
        throw new Error('테넌트 상태 업데이트 실패');
      }
      
      return response.json();
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/superadmin/tenants'] });
      toast({
        title: "상태 업데이트 완료",
        description: `${variables.status === 'active' ? '승인' : 
                      variables.status === 'suspended' ? '비활성화' : 
                      '상태 변경'}되었습니다.`,
      });
    },
    onError: (error) => {
      toast({
        title: "오류 발생",
        description: "상태 업데이트에 실패했습니다.",
        variant: "destructive",
      });
    }
  });

  // 테넌트 삭제 뮤테이션
  const deleteTenantMutation = useMutation({
    mutationFn: async (tenantId: string) => {
      const response = await fetch(`/api/superadmin/tenants/${tenantId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      
      if (!response.ok) {
        throw new Error('테넌트 삭제 실패');
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/superadmin/tenants'] });
      toast({
        title: "삭제 완료",
        description: "학원이 완전히 삭제되었습니다.",
      });
    },
    onError: (error) => {
      toast({
        title: "삭제 실패",
        description: "학원 삭제 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    }
  });

  const handleApprove = (tenantId: string) => {
    updateTenantMutation.mutate({ tenantId, status: 'active' });
  };

  const handleReject = (tenantId: string) => {
    updateTenantMutation.mutate({ tenantId, status: 'suspended' });
  };

  const handleSuspend = (tenantId: string) => {
    if (confirm('정말로 이 학원을 비활성화하시겠습니까?')) {
      updateTenantMutation.mutate({ tenantId, status: 'suspended' });
    }
  };

  const handleActivate = (tenantId: string) => {
    if (confirm('이 학원을 다시 활성화하시겠습니까?')) {
      updateTenantMutation.mutate({ tenantId, status: 'active' });
    }
  };

  const handleDelete = (tenantId: string, tenantName: string) => {
    if (confirm(`정말로 "${tenantName}" 학원을 완전히 삭제하시겠습니까?\n\n⚠️ 이 작업은 되돌릴 수 없으며, 모든 학생, 교사, 수업 데이터가 영구히 삭제됩니다.`)) {
      deleteTenantMutation.mutate(tenantId);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-6" data-testid="system-admin-page">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* 헤더 */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-3">
            <Crown className="h-10 w-10 text-yellow-400" />
            <h1 className="text-4xl font-bold text-white">시대영재 시스템 관리자</h1>
            <Crown className="h-10 w-10 text-yellow-400" />
          </div>
          <p className="text-purple-200 text-lg">
            절대적인 권력으로 학원들을 관리하세요
          </p>
        </div>

        {/* 통계 대시보드 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-slate-200">전체 학원</CardTitle>
              <Building2 className="h-4 w-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white">{stats.total}</div>
            </CardContent>
          </Card>

          <Card className="bg-yellow-900/30 border-yellow-700">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-yellow-200">승인 대기</CardTitle>
              <Clock className="h-4 w-4 text-yellow-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-yellow-400">{stats.pending}</div>
            </CardContent>
          </Card>

          <Card className="bg-green-900/30 border-green-700">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-green-200">활성 학원</CardTitle>
              <CheckCircle className="h-4 w-4 text-green-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-400">{stats.active}</div>
            </CardContent>
          </Card>

          <Card className="bg-red-900/30 border-red-700">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-red-200">정지된 학원</CardTitle>
              <XCircle className="h-4 w-4 text-red-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-400">{stats.suspended}</div>
            </CardContent>
          </Card>

          <Card className="bg-purple-900/30 border-purple-700">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-purple-200">만료된 학원</CardTitle>
              <TrendingUp className="h-4 w-4 text-purple-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-purple-400">{stats.expired}</div>
            </CardContent>
          </Card>
        </div>

        {/* 승인 대기 학원들 */}
        {stats.pending > 0 && (
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-white">
                <Shield className="h-5 w-5 text-yellow-400" />
                승인 대기 중인 학원들
              </CardTitle>
              <CardDescription className="text-slate-400">
                새로 가입한 학원들을 검토하고 승인하세요
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-96">
                <div className="space-y-4">
                  {tenants
                    .filter(tenant => tenant.status === 'pending')
                    .map((tenant) => (
                      <div 
                        key={tenant.id} 
                        className="p-4 bg-slate-700/50 rounded-lg border border-slate-600"
                        data-testid={`pending-tenant-${tenant.id}`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <h3 className="font-semibold text-white">{tenant.name}</h3>
                              <Badge variant="outline" className="text-yellow-400 border-yellow-400">
                                대기중
                              </Badge>
                            </div>
                            <div className="text-sm text-slate-300 space-y-1">
                              <p><strong>대표자:</strong> {tenant.ownerName}</p>
                              <p><strong>연락처:</strong> {tenant.ownerPhone}</p>
                              <p><strong>계정번호:</strong> {tenant.accountNumber}</p>
                              <p><strong>신청일:</strong> {new Date(tenant.createdAt).toLocaleDateString('ko-KR')}</p>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              onClick={() => handleApprove(tenant.id)}
                              disabled={updateTenantMutation.isPending}
                              className="bg-green-600 hover:bg-green-700 text-white"
                              data-testid={`button-approve-${tenant.id}`}
                            >
                              <UserCheck className="h-4 w-4 mr-2" />
                              승인
                            </Button>
                            <Button
                              onClick={() => handleReject(tenant.id)}
                              disabled={updateTenantMutation.isPending}
                              variant="destructive"
                              data-testid={`button-reject-${tenant.id}`}
                            >
                              <UserX className="h-4 w-4 mr-2" />
                              거부
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}

        {/* 전체 학원 목록 */}
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Building2 className="h-5 w-5 text-blue-400" />
              전체 학원 관리
            </CardTitle>
            <CardDescription className="text-slate-400">
              모든 학원의 현재 상태를 확인하고 관리하세요
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-96">
              <div className="space-y-3">
                {tenants.map((tenant) => (
                  <div 
                    key={tenant.id} 
                    className="p-4 bg-slate-700/30 rounded-lg border border-slate-600"
                    data-testid={`tenant-${tenant.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Building2 className="h-5 w-5 text-blue-400" />
                        <div>
                          <h4 className="font-medium text-white">{tenant.name}</h4>
                          <p className="text-sm text-slate-400">{tenant.ownerName}</p>
                          <p className="text-xs text-slate-500">{tenant.accountNumber}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge 
                          variant={
                            tenant.status === 'active' ? 'default' :
                            tenant.status === 'pending' ? 'secondary' :
                            'destructive'
                          }
                          className={
                            tenant.status === 'active' ? 'bg-green-600 text-white' :
                            tenant.status === 'pending' ? 'bg-yellow-600 text-white' :
                            'bg-red-600 text-white'
                          }
                        >
                          {
                            tenant.status === 'active' ? '활성' :
                            tenant.status === 'pending' ? '대기' :
                            tenant.status === 'suspended' ? '정지' :
                            '만료'
                          }
                        </Badge>
                        
                        {/* 관리 버튼들 */}
                        <div className="flex gap-1">
                          {tenant.status === 'active' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSuspend(tenant.id)}
                              disabled={updateTenantMutation.isPending}
                              className="h-8 w-8 p-0 border-orange-600 text-orange-400 hover:bg-orange-600 hover:text-white"
                              data-testid={`button-suspend-${tenant.id}`}
                            >
                              <Ban className="h-3 w-3" />
                            </Button>
                          )}
                          
                          {(tenant.status === 'suspended' || tenant.status === 'expired') && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleActivate(tenant.id)}
                              disabled={updateTenantMutation.isPending}
                              className="h-8 w-8 p-0 border-green-600 text-green-400 hover:bg-green-600 hover:text-white"
                              data-testid={`button-activate-${tenant.id}`}
                            >
                              <Play className="h-3 w-3" />
                            </Button>
                          )}
                          
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDelete(tenant.id, tenant.name)}
                            disabled={deleteTenantMutation.isPending}
                            className="h-8 w-8 p-0 border-red-600 text-red-400 hover:bg-red-600 hover:text-white"
                            data-testid={`button-delete-${tenant.id}`}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* 푸터 */}
        <div className="text-center">
          <p className="text-purple-300 text-sm">
            💼 절대적인 권력에는 절대적인 책임이 따릅니다 💼
          </p>
        </div>
      </div>
    </div>
  );
}